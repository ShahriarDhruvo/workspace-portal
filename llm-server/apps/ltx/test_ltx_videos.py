"""python3 -m unittest llm-server/apps/ltx/test_ltx_videos.py

ltx-videos.py's HTTP side and job handling with torch and LTX-2 replaced by stand-ins: no GPU, weights or LTX venv,
only Pillow and ffmpeg. The stand-in pipeline runs the real progress hook through 8 + 3 fake denoising steps, and
its encoder writes ffmpeg's test pattern with a tone, which then goes through the real faststart and stream checks.
"""

import base64
import contextlib
import importlib.util
import io
import json
import logging
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image

ANCESTRAL_OFFSET = 1000  # stands in for ltx_pipelines.distilled.ANCESTRAL_NOISE_SEED_OFFSET


def stub(name: str, **attrs) -> types.ModuleType:
    for depth in range(1, name.count(".") + 1):
        parent = ".".join(name.split(".")[:depth])
        sys.modules.setdefault(parent, types.ModuleType(parent))
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    return module


class Cuda:
    """torch.cuda: whether a GPU is visible, and which calls were made."""

    available = True
    calls: list[str] = []

    @classmethod
    def is_available(cls):
        cls.calls.append("is_available")
        return cls.available

    @classmethod
    def empty_cache(cls):
        cls.calls.append("empty_cache")

    current_device = staticmethod(lambda: 0)
    memory_allocated = max_memory_allocated = staticmethod(lambda: 0)
    reset_peak_memory_stats = staticmethod(lambda: None)


class Tokenizer:
    bos_token_id = 2

    def __call__(self, text):
        return SimpleNamespace(input_ids=text.split())


class Gemma:
    fail: Exception | None = None

    @classmethod
    def tokenizer(cls, assets):
        if cls.fail:
            raise cls.fail
        return Tokenizer()


class FakeDistilledPipeline:
    """DistilledPipeline's surface as ltx-videos.py uses it; records what each job asked for."""

    step_seconds = 0.0
    calls: list[dict] = []
    fail_prompt = "this prompt makes the decoder fail"

    def __init__(self, model_paths, spatial_upsampler_path, loras, device, registry):
        self.model_paths = model_paths

    def _sampler_kwargs(self, seed, noise_seed_offset):
        def loop(sigmas, video_state, audio_state, transformer, denoiser, v_context=None, a_context=None):
            for step in range(len(sigmas) - 1):  # as LTX-2's ancestral loop calls its denoiser
                time.sleep(self.step_seconds)
                denoiser(transformer, video_state, audio_state, sigmas, step, v_context, a_context)
            return video_state, audio_state

        return {"loop": loop}

    def stream_chunks(self, prompt, seed, height, width, frame_rate, images, num_frames, tiling_config):
        FakeDistilledPipeline.calls.append({"prompt": prompt, "seed": seed, "size": (width, height),
                                            "frames": num_frames, "images": images, "fps": frame_rate})

        def chunks():
            for offset, sigmas in ((ANCESTRAL_OFFSET, [1.0] * 9), (ANCESTRAL_OFFSET + 1, [1.0] * 4)):
                self._sampler_kwargs(seed, offset)["loop"](sigmas, None, None, None, lambda *args: None)
            if prompt == self.fail_prompt:
                raise RuntimeError("the decoder ran out of memory")
            yield SimpleNamespace(width=width, height=height, frames=num_frames)

        return chunks(), num_frames, tiling_config


def encode_media_segments(chunks, fps, output_path, video_chunks_number):
    (chunk,) = list(chunks)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={chunk.width}x{chunk.height}:rate=24",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-frames:v", str(chunk.frames),
                    "-shortest", "-c:v", H264, *(["-preset", "ultrafast"] if H264 == "libx264" else []),
                    "-c:a", "aac", "-ac", "2", "-y", str(output_path)], check=True)


class ImageConditioningInput:
    replace = staticmethod(lambda path, frame, strength: ("replace", Path(path).name, frame, strength))
    guide = staticmethod(lambda path, frame, strength: ("guide", Path(path).name, frame, strength))


class ModelPaths:
    from_split = staticmethod(lambda **paths: paths)


stub("torch", cuda=Cuda, device=lambda kind, index: (kind, index), inference_mode=contextlib.nullcontext)
stub("ltx_core.loader.placement", Placement=lambda device: device, RetentionPolicy=lambda clean: clean)
stub("ltx_core.loader.registry", ModelRegistry=lambda placement_policy: placement_policy)
stub("ltx_core.model.video_vae", AUTO_TILING="auto")
stub("ltx_core.text_encoders.gemma.gemma_assets", GemmaAssets=SimpleNamespace(load=lambda path: path),
     build_gemma_hf_tokenizer=Gemma.tokenizer)
stub("ltx_pipelines.distilled", ANCESTRAL_NOISE_SEED_OFFSET=ANCESTRAL_OFFSET, DistilledPipeline=FakeDistilledPipeline)
stub("ltx_pipelines.utils.media_io", encode_media_segments=encode_media_segments)
stub("ltx_pipelines.utils.model_paths", ModelPaths=ModelPaths)
stub("ltx_pipelines.utils.types", ImageConditioningInput=ImageConditioningInput)

_spec = importlib.util.spec_from_file_location("ltx_videos", Path(__file__).with_name("ltx-videos.py"))
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)

H264 = ""


def setUpModule():
    global H264
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        raise unittest.SkipTest("needs ffmpeg and ffprobe")
    encoders = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    H264 = next((name for name in ("libx264", "libopenh264") if f" {name} " in encoders), "")
    if not H264:
        raise unittest.SkipTest("needs an ffmpeg with libx264 or libopenh264")


GOOD = {"model": "ltx-2.5-distilled", "prompt": "a red fox runs through deep snow", "seconds": 5, "size": "512x512"}


def data_url(width, height, fmt="PNG", mime="png"):
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 50, 50)).save(out, fmt)
    return f"data:image/{mime};base64," + base64.b64encode(out.getvalue()).decode()


class Adapter(unittest.TestCase):
    """One ltx-videos server on an ephemeral port, its jobs and weights in a temporary folder."""

    ttl = 3600

    def setUp(self):
        Cuda.available, Cuda.calls[:] = True, []
        Gemma.fail = None
        FakeDistilledPipeline.calls[:] = []
        FakeDistilledPipeline.step_seconds = 0.0
        work = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.models, self.root = work / "models", work / "jobs"
        for file in [*L.FILES.values(), L.VIDEO_VAES["conv"]]:
            (self.models / file).parent.mkdir(parents=True, exist_ok=True)
            (self.models / file).touch()
        self.args = SimpleNamespace(models=self.models, video_vae="conv", root=self.root, ttl=self.ttl)
        self.prepare()
        self.start()

    def prepare(self):
        """Runs before the server starts."""

    def start(self):
        self.server = L.Server(self.args)
        self.worker = threading.Thread(target=self.server.serve, daemon=True)
        self.worker.start()
        self.httpd = L.ThreadingHTTPServer(("127.0.0.1", 0), L.handler(self.server))
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.port = self.httpd.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        for _ in range(500):
            if self.server.status != "loading":
                return
            time.sleep(0.01)
        self.fail("the server never left loading")

    def call(self, method, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers=headers or ({"Content-Type": "application/json"} if data else {}))
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read(), dict(error.headers)

    def jcall(self, *args, **kwargs):
        status, body, headers = self.call(*args, **kwargs)
        return status, json.loads(body) if body else None, headers

    def create(self, **fields):
        status, job, headers = self.jcall("POST", "/v1/videos", {**GOOD, **fields})
        self.assertEqual(status, 202, job)
        return job

    def wait(self, job_id, until=("completed", "failed", "cancelled")):
        seen = []
        for _ in range(1500):
            status, job, _ = self.jcall("GET", f"/v1/videos/{job_id}")
            self.assertEqual(status, 200, job)
            seen.append(job["progress"])
            if job["status"] in until:
                return job, seen
            time.sleep(0.01)
        self.fail(f"job {job_id} never ended: {job}")

    def raw(self, request: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as sock:
            sock.sendall(request)
            answer = b""
            while chunk := sock.recv(65536):
                answer += chunk
        return answer


class LoadFails(Adapter):
    def start(self):
        """The tests start it themselves."""

    def died(self) -> str:
        """Runs the worker, which must end the process with status 1; returns what it logged."""
        with mock.patch.object(L.os, "_exit", side_effect=SystemExit) as leave, \
                self.assertLogs("ltx-videos", "ERROR") as logs, self.assertRaises(SystemExit):
            L.Server(self.args).serve()
        leave.assert_called_once_with(1)
        return "\n".join(logs.output)

    def test_missing_weights(self):
        (self.models / L.FILES["upsampler"]).unlink()
        self.assertIn(f"weights are missing: 1 of 5 files not in {self.models} ({L.FILES['upsampler']})", self.died())
        self.assertNotIn("is_available", Cuda.calls, "the GPU is touched only once the weights are there")

    def test_no_gpu(self):
        Cuda.available = False
        self.assertIn("no ROCm GPU visible", self.died())

    def test_the_engine_fails(self):
        Gemma.fail = RuntimeError("HIP out of memory")
        self.assertIn("HIP out of memory", self.died())


class Requests(Adapter):
    def test_ready_after_the_warm_up(self):
        self.assertEqual(self.jcall("GET", "/ready"), (200, {"status": "ready"}, mock.ANY))
        self.assertEqual(self.jcall("GET", "/health")[1], {"status": "ready"})
        warm_up = FakeDistilledPipeline.calls[0]
        self.assertEqual((warm_up["size"], warm_up["frames"]), ((256, 256), 9))
        self.assertFalse((self.root / ".warm-up.mp4").exists())
        paths = self.server.pipeline.model_paths
        self.assertTrue(paths["video_vae_path"].endswith("vae/ltx-2.5-video-vae-conv-bf16.safetensors"))

    def test_while_the_models_load(self):
        self.server.status = "loading"
        self.assertEqual(self.jcall("GET", "/ready")[:2], (503, {"status": "loading"}))
        self.assertEqual(self.jcall("GET", "/health")[:2], (200, {"status": "loading"}))
        self.assertEqual(self.jcall("POST", "/v1/videos", GOOD)[0], 503)

    def test_bad_requests(self):
        bad = [
            ({**GOOD, "model": "minimax-h3"}, "model"),
            ({k: v for k, v in GOOD.items() if k != "prompt"}, "prompt"),
            ({**GOOD, "prompt": "   "}, "prompt"),
            ({**GOOD, "prompt": "a\0b"}, "prompt"),
            ({**GOOD, "prompt": "word " * 1024}, "1025 tokens"),
            ({k: v for k, v in GOOD.items() if k != "seconds"}, "seconds"),
            ({**GOOD, "seconds": 0.5}, "seconds must be from 1 to 20"),
            ({**GOOD, "seconds": 20.5}, "seconds must be from 1 to 20"),
            ({**GOOD, "seconds": "abc"}, "seconds must be a number"),
            ({**GOOD, "seconds": True}, "seconds"),
            ({**GOOD, "size": "1920x1080"}, "size must be one of 512x512, 1344x768, 768x1344"),
            ({**GOOD, "input_reference": "x"}, "unsupported field(s): input_reference"),
            ({**GOOD, "gufo": {"preset": "fast"}}, "no presets"),
            ({**GOOD, "gufo": "fast"}, "gufo may hold only seed"),
            ({**GOOD, "gufo": {"seed": 1}, "seed": 2}, "differ"),
            ({**GOOD, "seed": -1}, "seed"),
            ({**GOOD, "seed": 2**32}, "seed"),
            ({**GOOD, "seed": "7"}, "seed"),
            ({**GOOD, "seed": 1.5}, "seed"),
            ({**GOOD, "first_frame": "https://example.com/a.png"}, "data URL"),
            ({**GOOD, "first_frame": "data:image/png;base64,!!!"}, "base64"),
            ({**GOOD, "first_frame": "data:image/png;base64," + base64.b64encode(b"not an image").decode()},
             "decodable"),
            ({**GOOD, "first_frame": data_url(1000, 200)}, "aspect ratio"),
            ({**GOOD, "last_frame": data_url(64, 64, "GIF", "gif")}, "PNG, JPEG or WebP, not GIF"),
            ([GOOD], "JSON object"),
        ]
        for body, words in bad:
            with self.subTest(words=words, body=str(body)[:80]):
                status, answer, _ = self.jcall("POST", "/v1/videos", body)
                self.assertEqual(status, 400, answer)
                self.assertEqual(answer["error"]["type"], "invalid_request_error")
                self.assertIn(words, answer["error"]["message"])
        self.assertEqual(len(FakeDistilledPipeline.calls), 1, "only the warm-up reached the model")

    def test_other_errors(self):
        status, answer, _ = self.jcall("POST", "/v1/videos", raw=b"{not json",
                                       headers={"Content-Type": "application/json"})
        self.assertEqual((status, answer["error"]["message"]), (400, "the body is not valid JSON"))
        status, answer, _ = self.jcall("POST", "/v1/videos", raw=b"model=x",
                                       headers={"Content-Type": "multipart/form-data; boundary=x"})
        self.assertEqual(status, 400)
        self.assertIn("as JSON", answer["error"]["message"])
        self.assertEqual(self.jcall("GET", "/v1/videos/video_000000000000000000000000")[0], 404)
        self.assertEqual(self.jcall("GET", "/v1/videos/../../etc/passwd")[0], 404)
        self.assertEqual(self.jcall("GET", "/v1/other")[0], 404)
        self.assertEqual(self.jcall("POST", "/v1/other", GOOD)[0], 404)
        self.assertEqual(self.jcall("DELETE", "/v1/videos/video_000000000000000000000000/content")[0], 404)
        answer = self.raw(b"POST /v1/videos HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                          b"Content-Length: 70000000\r\n\r\n")
        self.assertTrue(answer.startswith(b"HTTP/1.1 413"), answer[:100])

    def test_text_to_video(self):
        with self.assertLogs("ltx-videos", "INFO") as logs:
            job = self.create(gufo={"seed": 42})
            self.assertEqual((job["object"], job["status"], job["model"], job["seed"], job["seconds"], job["size"]),
                             ("video", "queued", "ltx-2.5-distilled", 42, "5", "512x512"))
            self.assertTrue(L.JOB_ID.fullmatch(job["id"]))
            final, seen = self.wait(job["id"])
        self.assertEqual((final["status"], final["progress"], final["error"]), ("completed", 100, None))
        self.assertEqual(final["expires_at"] - final["completed_at"], 3600)
        self.assertEqual(seen, sorted(seen))
        call = FakeDistilledPipeline.calls[-1]
        self.assertEqual((call["prompt"], call["seed"], call["size"], call["frames"], call["fps"], call["images"]),
                         (GOOD["prompt"], 42, (512, 512), 121, 24.0, []))

        status, mp4, headers = self.call("GET", f"/v1/videos/{job['id']}/content")
        self.assertEqual((status, headers["Content-Type"]), (200, "video/mp4"))
        self.assertIn(f'filename="{job["id"]}.mp4"', headers["Content-Disposition"])
        self.assertLess(mp4.find(b"moov"), mp4.find(b"mdat"), "faststart: the index comes first")
        self.assertEqual(sorted(p.name for p in (self.root / job["id"]).iterdir()), ["job.json", "output.mp4"])
        self.assertNotIn(b"fox", (self.root / job["id"] / "job.json").read_bytes())
        self.assertFalse(any("fox" in line for line in logs.output), "the prompt stays out of the journal")

    def test_location_and_409_before_the_video(self):
        FakeDistilledPipeline.step_seconds = 0.05
        status, job, headers = self.jcall("POST", "/v1/videos", {**GOOD, "seed": 7})
        self.assertEqual(headers["Location"], f"/v1/videos/{job['id']}")
        status, answer, _ = self.jcall("GET", f"/v1/videos/{job['id']}/content")
        self.assertEqual((status, answer["error"]["message"]), (409, "video content is not ready"))
        final, seen = self.wait(job["id"])
        stage_1, decode = L.PROGRESS["stage 1"], L.PROGRESS["decode"]
        self.assertTrue([p for p in seen if stage_1 < p < decode], f"progress during the steps: {seen}")

    def test_random_seed_and_frame_counts(self):
        seeds = set()
        for seconds, frames in ((1, 25), ("2.5", 65), (5, 121), (20, 481), (14.375, 345)):
            with self.subTest(seconds=seconds):
                job = self.create(seconds=seconds)
                self.assertEqual(job["seconds"], str(seconds) if isinstance(seconds, str) else f"{seconds:g}")
                self.assertEqual(self.server.store.jobs[job["id"]].frames, frames)
                seeds.add(job["seed"])
                self.assertEqual(self.wait(job["id"])[0]["status"], "completed")
        self.assertGreater(len(seeds), 1, "a seed left out is random")

    def test_keyframes(self):
        job = self.create(seconds="2.5", size="1344x768", seed=7, first_frame=data_url(1664, 928),
                          last_frame=data_url(800, 800))
        self.assertEqual(self.wait(job["id"])[0]["status"], "completed")
        call = FakeDistilledPipeline.calls[-1]
        self.assertEqual((call["size"], call["frames"]), ((1344, 768), 65))
        self.assertEqual(call["images"], [("replace", "first_frame.png", 0, 1.0), ("guide", "last_frame.png", 64, 1.0)])
        self.assertEqual(sorted(p.name for p in (self.root / job["id"]).iterdir()), ["job.json", "output.mp4"])

        portrait = self.create(first_frame=data_url(720, 1280, "JPEG", "jpeg"))
        self.wait(portrait["id"])
        self.assertEqual(FakeDistilledPipeline.calls[-1]["size"], (384, 704))
        last_only = self.create(size="768x1344", last_frame=data_url(1280, 720, "WEBP", "webp"))
        self.wait(last_only["id"])
        self.assertEqual(FakeDistilledPipeline.calls[-1]["size"], (1344, 768))
        self.assertEqual(FakeDistilledPipeline.calls[-1]["images"], [("guide", "last_frame.png", 120, 1.0)])

    def test_queue_and_cancel(self):
        FakeDistilledPipeline.step_seconds = 0.1
        ids = [self.create(seconds=1)["id"] for _ in range(3)]
        time.sleep(0.3)
        states = [self.jcall("GET", f"/v1/videos/{i}")[1]["status"] for i in ids]
        self.assertEqual(states, ["in_progress", "queued", "queued"])

        status, deleted, _ = self.jcall("DELETE", f"/v1/videos/{ids[1]}")
        self.assertEqual((status, deleted), (200, {"id": ids[1], "object": "video.deleted", "deleted": True}))
        self.assertFalse((self.root / ids[1]).exists())
        self.assertEqual(self.jcall("DELETE", f"/v1/videos/{ids[0]}")[0], 200)
        self.assertEqual(self.jcall("GET", f"/v1/videos/{ids[0]}")[0], 404)
        final, _ = self.wait(ids[2])
        self.assertEqual(final["status"], "completed")
        self.assertFalse((self.root / ids[0]).exists(), "the cancelled job's files are deleted")
        self.assertEqual(self.jcall("DELETE", f"/v1/videos/{ids[1]}")[0], 404)
        self.assertEqual([c["frames"] for c in FakeDistilledPipeline.calls[1:]], [25, 25], "the queued one never ran")

    def test_a_failed_job(self):
        with self.assertLogs("ltx-videos", "ERROR"):
            job = self.create(prompt=FakeDistilledPipeline.fail_prompt)
            final, _ = self.wait(job["id"])
        self.assertEqual((final["status"], final["error"]["code"]), ("failed", "generation_failed"))
        self.assertIn("the decoder ran out of memory", final["error"]["message"])
        self.assertEqual(self.jcall("GET", f"/v1/videos/{job['id']}/content")[0], 409)
        self.assertEqual(sorted(p.name for p in (self.root / job["id"]).iterdir()), ["job.json"])
        self.assertEqual(self.wait(self.create()["id"])[0]["status"], "completed", "the next job still runs")

    def test_a_worker_that_dies_ends_the_process(self):
        with mock.patch.object(L.os, "_exit", side_effect=SystemExit) as leave, \
                mock.patch.object(Cuda, "reset_peak_memory_stats", side_effect=RuntimeError("HIP error")), \
                self.assertLogs("ltx-videos", "ERROR") as logs:
            self.create()
            self.worker.join(5)
        leave.assert_called_once_with(1)
        self.assertIn("HIP error", "\n".join(logs.output))

    def test_chunked_body(self):
        body = json.dumps(GOOD).encode()
        answer = self.raw(b"POST /v1/videos HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                          b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                          + f"{len(body) - 10:x}\r\n".encode() + body[:-10] + b"\r\n"
                          + b"a\r\n" + body[-10:] + b"\r\n0\r\n\r\n")
        self.assertTrue(answer.startswith(b"HTTP/1.1 202"), answer[:200])
        self.wait(json.loads(answer.split(b"\r\n\r\n", 1)[1])["id"])


class Restart(Adapter):
    def prepare(self):
        now = int(time.time())
        for name, status, files in (("video_aaaaaaaaaaaaaaaaaaaaaaaa", "completed", ["output.mp4"]),
                                    ("video_bbbbbbbbbbbbbbbbbbbbbbbb", "in_progress", ["raw.mp4", "first_frame.png"]),
                                    ("video_cccccccccccccccccccccccc", "queued", []),
                                    ("video_dddddddddddddddddddddddd", "completed", [])):
            folder = self.root / name
            folder.mkdir(parents=True)
            for file in files:
                (folder / file).write_bytes(b"x")
            (folder / "job.json").write_text(json.dumps({
                "id": name, "created_at": now, "status": status, "progress": 40, "size": "512x512", "seconds": "5",
                "seed": 3, "completed_at": now if status == "completed" else None,
                "expires_at": now + 3600 if status == "completed" else None, "error": None}))
        (self.root / "not-a-job").mkdir()
        (self.root / "stray.tmp").write_bytes(b"x")

    def start(self):
        with self.assertLogs("ltx-videos", "WARNING"):
            super().start()

    def test_jobs_come_back(self):
        status, job, _ = self.jcall("GET", "/v1/videos/video_aaaaaaaaaaaaaaaaaaaaaaaa")
        self.assertEqual((status, job["status"], job["seed"]), (200, "completed", 3))
        self.assertEqual(self.call("GET", "/v1/videos/video_aaaaaaaaaaaaaaaaaaaaaaaa/content")[:2], (200, b"x"))
        for name in ("video_bbbbbbbbbbbbbbbbbbbbbbbb", "video_cccccccccccccccccccccccc"):
            job = self.jcall("GET", f"/v1/videos/{name}")[1]
            self.assertEqual((job["status"], job["error"]["code"]), ("failed", "interrupted"))
            self.assertEqual(sorted(p.name for p in (self.root / name).iterdir()), ["job.json"])
        self.assertEqual(self.jcall("GET", "/v1/videos/video_dddddddddddddddddddddddd")[0], 404, "its video is gone")
        self.assertEqual(sorted(p.name for p in self.root.iterdir()),
                         ["video_aaaaaaaaaaaaaaaaaaaaaaaa", "video_bbbbbbbbbbbbbbbbbbbbbbbb",
                          "video_cccccccccccccccccccccccc"])


class Expiry(Adapter):
    ttl = 1

    def test_a_job_is_gone_after_its_ttl(self):
        job = self.create(seconds=1)
        self.wait(job["id"])
        self.assertEqual(self.call("GET", f"/v1/videos/{job['id']}/content")[0], 200)
        time.sleep(1.2)
        self.assertEqual(self.jcall("GET", f"/v1/videos/{job['id']}")[0], 404)
        self.assertFalse((self.root / job["id"]).exists())


if __name__ == "__main__":
    logging.basicConfig(level=logging.CRITICAL)
    unittest.main()
