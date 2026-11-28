"""LTX-2.5 22B distilled behind Gufo's video job API (OpenAI's /v1/videos), so the portal's generate_video tool and
gateway drive it as they drive MiniMax H3.

  POST   /v1/videos               JSON (below); answers 202 with the job, status "queued"
  GET    /v1/videos/{id}          the job: status queued, in_progress, completed, failed or cancelled, progress 0-100
  GET    /v1/videos/{id}/content  the MP4 (H.264 and AAC, faststart) once the job completed, else 409
  DELETE /v1/videos/{id}          cancels the job and deletes its files
  GET    /ready                   200 once the models are loaded and a warm-up clip is made (llama-swap's check)
  GET    /health                  200 while the process runs, with the status: loading or ready

POST /v1/videos takes model "ltx-2.5-distilled", prompt (up to 1,024 tokens), seconds (1 to 20, as a number or a
string; rounded up to the model's 8n+1 frames at 24 per second), size (SIZES, default 512x512), first_frame and
last_frame (base64 PNG, JPEG or WebP data URLs, up to 20 MiB each), and seed or Gufo's gufo.seed (random if left
out). With a keyframe, size is the pixel budget and the keyframe's aspect ratio (1:4 to 4:1) is kept, as Gufo does.
Errors are {"error": {"message", "type"}}, 400 for a bad request. One job runs at a time, the rest wait in order.
A job that ended is kept with its files for --ttl seconds, across restarts too: llama-swap stops this server
whenever another model is asked for. Prompts are never logged or written to disk.

When the weights are missing, loading fails or the worker that makes the videos dies, the server logs the reason and
exits with status 1. ltx.service has Restart=no, so systemd does not start it again, and llama-swap sees the unit
end and fails the request at once. A server left up with /ready at 503 would keep the other models stopped until
llama-swap's healthCheckTimeout, on every request, and one without its worker would queue jobs forever.

install.sh puts this file in the root of the LTX-2 checkout; ltx.service runs it with that venv's Python.
"""

import argparse
import base64
import binascii
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import torch
from PIL import Image, ImageOps

from ltx_core.loader.placement import Placement, RetentionPolicy
from ltx_core.loader.registry import ModelRegistry
from ltx_core.model.video_vae import AUTO_TILING
from ltx_core.text_encoders.gemma.gemma_assets import GemmaAssets, build_gemma_hf_tokenizer
from ltx_pipelines.distilled import ANCESTRAL_NOISE_SEED_OFFSET, DistilledPipeline
from ltx_pipelines.utils.media_io import encode_media_segments
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.types import ImageConditioningInput

MODEL_ID = "ltx-2.5-distilled"
FPS = 24
# Output sizes; each side a multiple of 64, as the two stages need (stage 1 runs at half of each side).
SIZES = {"512x512": (512, 512), "1344x768": (1344, 768), "768x1344": (768, 1344)}
SECONDS_MIN, SECONDS_MAX = 1.0, 20.0
# The text encoder's input (LTX-2's TOKENIZER_MAX_LENGTH): it cuts longer prompts off unseen, so they are refused.
PROMPT_TOKENS = 1024
IMAGE_BYTES = 20 * 1024 * 1024
IMAGE_PIXELS = 32_000_000
IMAGE_FORMATS = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}
# Two keyframes of 20 MiB as base64, with room for the rest.
BODY_BYTES = 64 * 1024 * 1024
FIELDS = {"model", "prompt", "seconds", "size", "first_frame", "last_frame", "seed", "gufo"}
DATA_URL = re.compile(r"data:image/[\w.+-]+;base64,(.*)", re.DOTALL)
JOB_ID = re.compile(r"video_[0-9a-f]{24}")
FILES = {
    "transformer": "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
    "text_encoder": "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    "audio_vae": "vae/ltx-2.5-audio-vae-bf16.safetensors",
    "upsampler": "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
}
VIDEO_VAES = {
    "diffusion": "vae/ltx-2.5-video-vae-bf16.safetensors",
    "conv": "vae/ltx-2.5-video-vae-conv-bf16.safetensors",
}
# Share of the progress bar each part takes, from where it starts: prompt, stage 1, upscale with stage 2, decode.
PROGRESS = {"prompt": 2, "stage 1": 6, "stage 2": 50, "decode": 80, "mux": 97}
# ffmpeg only copies the streams of a clip of at most 20 s, and ffprobe only counts its packets: one that hangs
# fails its job instead of holding up every job behind it.
MUX_SECONDS = 60

log = logging.getLogger("ltx-videos")


class BadRequest(Exception):
    """A request the client has to change; answered with 400."""


class Cancelled(Exception):
    """The job was cancelled while it ran."""


@dataclass
class Job:
    id: str
    created_at: int
    size: str
    seconds: str
    seed: int
    width: int
    height: int
    frames: int
    prompt: str = field(repr=False)
    keyframes: dict[str, Path] = field(default_factory=dict)
    status: str = "queued"
    progress: int = 0
    completed_at: int | None = None
    expires_at: int | None = None
    error: dict | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def view(self) -> dict:
        return {"id": self.id, "object": "video", "created_at": self.created_at, "status": self.status,
                "progress": self.progress, "model": MODEL_ID, "size": self.size, "seconds": self.seconds,
                "seed": self.seed, "completed_at": self.completed_at, "expires_at": self.expires_at,
                "error": self.error}


class Store:
    """The jobs, in memory and as root/<id>/job.json (no prompt) with the finished root/<id>/output.mp4."""

    def __init__(self, root: Path, ttl: int):
        self.root, self.ttl = root, ttl
        self.lock = threading.Condition()
        self.jobs: dict[str, Job] = {}
        self.queue: deque[Job] = deque()
        self.root.mkdir(parents=True, exist_ok=True)
        self._restore()

    def _restore(self) -> None:
        """Takes back the jobs of an earlier run; one that was still waiting or running then has failed."""
        for directory in self.root.iterdir():
            if not directory.is_dir():
                directory.unlink()
                continue
            try:
                saved = json.loads((directory / "job.json").read_text())
                job = Job(id=saved["id"], created_at=saved["created_at"], size=saved["size"], seconds=saved["seconds"],
                          seed=saved["seed"], width=0, height=0, frames=0, prompt="", status=saved["status"],
                          progress=saved["progress"], completed_at=saved["completed_at"],
                          expires_at=saved["expires_at"], error=saved["error"])
                if directory.name != job.id or not JOB_ID.fullmatch(job.id):
                    raise ValueError("not a job folder")
                if job.status == "completed" and not (directory / "output.mp4").is_file():
                    raise ValueError("its video is missing")
            except (OSError, ValueError, KeyError, TypeError) as exc:
                log.warning("removing %s: %s", directory.name, exc)
                shutil.rmtree(directory, ignore_errors=True)
                continue
            if job.status in ("queued", "in_progress"):
                self._end(job, "failed", {"code": "interrupted",
                                          "message": "the video server stopped before the job ended"})
            self.jobs[job.id] = job
        self.sweep()

    def path(self, job: Job, name: str = "") -> Path:
        return self.root / job.id / name

    def save(self, job: Job) -> None:
        tmp = self.path(job, "job.json.tmp")
        tmp.write_text(json.dumps(job.view()))
        tmp.replace(self.path(job, "job.json"))

    def _end(self, job: Job, status: str, error: dict | None = None) -> None:
        """Records how the job ended and deletes its files but job.json and a finished output.mp4."""
        job.status, job.error, job.prompt = status, error, ""
        if status == "completed":
            job.progress = 100
        job.completed_at = int(time.time())
        job.expires_at = job.completed_at + self.ttl
        keep = {"job.json", "output.mp4"} if status == "completed" else {"job.json"}
        for file in self.path(job).iterdir():
            if file.name not in keep:
                file.unlink()
        self.save(job)

    def end(self, job: Job, status: str, error: dict | None = None) -> None:
        with self.lock:
            if job.id in self.jobs:
                self._end(job, status, error)

    def add(self, job: Job, keyframes: dict[str, Image.Image]) -> None:
        with self.lock:
            self.sweep()
            self.path(job).mkdir()
            for name, image in keyframes.items():
                job.keyframes[name] = self.path(job, f"{name}.png")
                image.save(job.keyframes[name])
            self.save(job)
            self.jobs[job.id] = job
            self.queue.append(job)
            self.lock.notify_all()

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            self.sweep()
            return self.jobs.get(job_id)

    def delete(self, job_id: str) -> Job | None:
        """Forgets the job; a running one stops at its next step and the worker then deletes its files."""
        with self.lock:
            job = self.jobs.pop(job_id, None)
            if job is None:
                return None
            job.cancel.set()
            if job in self.queue:
                self.queue.remove(job)
            if job.status != "in_progress":
                shutil.rmtree(self.path(job), ignore_errors=True)
            return job

    def next(self) -> Job:
        with self.lock:
            while not self.queue:
                self.lock.wait(timeout=60)
                self.sweep()
            job = self.queue.popleft()
            job.status, job.progress = "in_progress", 1
            self.save(job)
            return job

    def sweep(self) -> None:
        now = time.time()
        for job in [j for j in self.jobs.values() if j.expires_at is not None and j.expires_at <= now]:
            del self.jobs[job.id]
            shutil.rmtree(self.path(job), ignore_errors=True)


class Pipeline(DistilledPipeline):
    """DistilledPipeline that reports each denoising step to `on_step` and stops a cancelled job between steps."""

    on_step = staticmethod(lambda stage, done, total: None)

    def _sampler_kwargs(self, seed: int, noise_seed_offset: int) -> dict[str, Any]:
        sampler = super()._sampler_kwargs(seed, noise_seed_offset)
        if "loop" not in sampler:  # a checkpoint before LTX-2.5 samples without the ancestral loop: no progress then
            return sampler
        loop = sampler["loop"]
        stage = "stage 1" if noise_seed_offset == ANCESTRAL_NOISE_SEED_OFFSET else "stage 2"

        def counted(sigmas, video_state, audio_state, transformer, denoiser, *args, **kwargs):
            total = len(sigmas) - 1

            def step(*step_args):
                result = denoiser(*step_args)
                self.on_step(stage, step_args[4] + 1, total)
                return result

            return loop(sigmas, video_state, audio_state, transformer, step, *args, **kwargs)

        return {**sampler, "loop": counted}


class Server:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.store = Store(args.root, args.ttl)
        self.status = "loading"
        self.tokenizer = None
        self.tokenizing = threading.Lock()
        self.pipeline: Pipeline | None = None

    # Requests

    def parse(self, body: Any) -> tuple[Job, dict[str, Image.Image]]:
        if not isinstance(body, dict):
            raise BadRequest("the body must be a JSON object")
        unknown = sorted(set(body) - FIELDS)
        if unknown:
            raise BadRequest(f"unsupported field(s): {', '.join(unknown)}")
        if body.get("model") != MODEL_ID:
            raise BadRequest(f"model must be '{MODEL_ID}'")
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip() or "\0" in prompt:
            raise BadRequest("prompt is required: the shot, as text")
        with self.tokenizing:
            ids = self.tokenizer(prompt.strip()).input_ids
        tokens = len(ids) + (0 if ids and ids[0] == self.tokenizer.bos_token_id else 1)  # LTX-2 adds a <bos>
        if tokens > PROMPT_TOKENS:
            raise BadRequest(f"prompt is {tokens} tokens; the text encoder reads at most {PROMPT_TOKENS}")
        seconds_value = body.get("seconds")
        if isinstance(seconds_value, str):
            seconds_text = seconds_value.strip()
        elif isinstance(seconds_value, (int, float)) and not isinstance(seconds_value, bool):
            seconds_text = f"{seconds_value:g}"
        else:
            raise BadRequest("seconds is required: a number or a numeric string")
        try:
            seconds = float(seconds_text)
        except ValueError:
            raise BadRequest("seconds must be a number") from None
        if not (SECONDS_MIN <= seconds <= SECONDS_MAX):
            raise BadRequest(f"seconds must be from {SECONDS_MIN:g} to {SECONDS_MAX:g}")
        frames = math.ceil((seconds * FPS - 1) / 8) * 8 + 1
        size = body.get("size", "512x512")
        if size not in SIZES:
            raise BadRequest(f"size must be one of {', '.join(SIZES)}")
        seed = body.get("seed")
        extension = body.get("gufo")
        if extension is not None:
            if not isinstance(extension, dict) or set(extension) - {"seed"}:
                raise BadRequest("gufo may hold only seed: this model has no presets")
            if seed is not None and extension.get("seed", seed) != seed:
                raise BadRequest("seed and gufo.seed differ")
            seed = extension.get("seed", seed)
        if seed is None:
            seed = secrets.randbelow(2**32)
        elif isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**32:
            raise BadRequest("seed must be an integer from 0 to 4294967295")
        keyframes = {name: keyframe(name, body[name]) for name in ("first_frame", "last_frame") if name in body}
        width, height = SIZES[size]
        if keyframes:
            shape = next(iter(keyframes.values()))
            width, height = canvas(width * height, shape.width / shape.height)
        job = Job(id=f"video_{secrets.token_hex(12)}", created_at=int(time.time()), size=size, seconds=seconds_text,
                  seed=seed, width=width, height=height, frames=frames, prompt=prompt)
        return job, keyframes

    # Work

    def load(self) -> None:
        """Loads every model onto the GPU and makes a warm-up clip."""
        started = time.monotonic()
        models = self.args.models
        paths = {name: models / file for name, file in FILES.items()}
        paths["video_vae"] = models / VIDEO_VAES[self.args.video_vae]
        missing = [file for file in paths.values() if not file.is_file()]
        if missing:  # checked before the GPU is touched
            raise RuntimeError(
                f"the LTX-2.5 weights are missing: {len(missing)} of {len(paths)} files not in {models} "
                f"({', '.join(str(file.relative_to(models)) for file in missing)}); "
                "download them from Lightricks/LTX-2.5")
        if not torch.cuda.is_available():
            raise RuntimeError("no ROCm GPU visible to torch")
        self.tokenizer = build_gemma_hf_tokenizer(GemmaAssets.load(paths["text_encoder"]))
        device = torch.device("cuda", torch.cuda.current_device())
        # Every model's weights stay on the GPU between jobs instead of being read from disk for each.
        registry = ModelRegistry(placement_policy=RetentionPolicy(clean=Placement(device)))
        self.pipeline = Pipeline(
            model_paths=ModelPaths.from_split(
                transformer_path=str(paths["transformer"]), text_encoder_path=str(paths["text_encoder"]),
                video_vae_path=str(paths["video_vae"]), audio_vae_path=str(paths["audio_vae"]),
            ),
            spatial_upsampler_path=str(paths["upsampler"]), loras=[], device=device, registry=registry,
        )
        warm = Job(id="warm-up", created_at=0, size="", seconds="", seed=0, width=256, height=256, frames=9,
                   prompt="A red ball rolls slowly across a wooden table. Soft room tone.")
        out = self.args.root / ".warm-up.mp4"
        self.render(warm, out)
        out.unlink()
        self.status = "ready"
        log.info("ready in %.1f s (%s video VAE); %.1f GiB of GPU memory in use", time.monotonic() - started,
                 self.args.video_vae, torch.cuda.memory_allocated() / 2**30)

    def render(self, job: Job, out: Path) -> None:
        """Generates the job's clip into out (MP4, not yet faststart)."""
        images = []
        if "first_frame" in job.keyframes:
            images.append(ImageConditioningInput.replace(str(job.keyframes["first_frame"]), 0, 1.0))
        if "last_frame" in job.keyframes:
            images.append(ImageConditioningInput.guide(str(job.keyframes["last_frame"]), job.frames - 1, 1.0))

        def on_step(stage: str, done: int, total: int) -> None:
            if job.cancel.is_set():
                raise Cancelled
            end = PROGRESS["stage 2"] if stage == "stage 1" else PROGRESS["decode"]
            job.progress = PROGRESS[stage] + (end - PROGRESS[stage]) * done // total

        self.pipeline.on_step = on_step
        job.progress = PROGRESS["prompt"]
        with torch.inference_mode():
            chunks, _, _ = self.pipeline.stream_chunks(
                prompt=job.prompt, seed=job.seed, height=job.height, width=job.width, frame_rate=float(FPS),
                images=images, num_frames=job.frames, tiling_config=AUTO_TILING,
            )
            job.progress = PROGRESS["stage 1"]
            encode_media_segments(chunks, fps=float(FPS), output_path=out, video_chunks_number=None)

    def run(self, job: Job) -> None:
        started = time.monotonic()
        torch.cuda.reset_peak_memory_stats()
        raw, final = self.store.path(job, "raw.mp4"), self.store.path(job, "output.mp4")
        log.info("job %s started: %dx%d, %d frames, seed %d, keyframes %s", job.id, job.width, job.height,
                 job.frames, job.seed, ",".join(job.keyframes) or "none")
        try:
            self.render(job, raw)
            if job.cancel.is_set():
                raise Cancelled
            job.progress = PROGRESS["mux"]
            faststart(raw, final, job.frames)
            raw.unlink()
            self.store.end(job, "completed")
            log.info("job %s completed in %.1f s; peak %.1f GiB allocated", job.id, time.monotonic() - started,
                     torch.cuda.max_memory_allocated() / 2**30)
        except Cancelled:
            log.info("job %s cancelled after %.1f s", job.id, time.monotonic() - started)
            self.store.end(job, "cancelled", {"code": "cancelled", "message": "video generation was cancelled"})
        except Exception as exc:
            log.exception("job %s failed after %.1f s", job.id, time.monotonic() - started)
            self.store.end(job, "failed", {"code": "generation_failed", "message": f"video generation failed: {exc}"})
        finally:
            raw.unlink(missing_ok=True)
            if job.id not in self.store.jobs:  # deleted while it ran
                shutil.rmtree(self.store.path(job), ignore_errors=True)

    def serve(self) -> None:
        """Loads the models, then makes the queued jobs' videos one after another. Whatever ends it ends the process,
        so systemd and llama-swap see it."""
        try:
            self.load()
            while True:
                self.run(self.store.next())
        except BaseException:
            log.exception("the worker died")
            os._exit(1)  # sys.exit would end only this thread


def keyframe(name: str, value: Any) -> Image.Image:
    """The image of a data URL, upright and in RGB, checked as Gufo checks keyframes."""
    match = DATA_URL.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise BadRequest(f"{name} must be a base64 image data URL (data:image/png;base64,...)")
    try:
        data = base64.b64decode(match.group(1), validate=True)
    except binascii.Error:
        raise BadRequest(f"{name} is not valid base64") from None
    if not data or len(data) > IMAGE_BYTES:
        raise BadRequest(f"{name} is empty or larger than {IMAGE_BYTES // 2**20} MiB")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in IMAGE_FORMATS:
                raise BadRequest(f"{name} must be PNG, JPEG or WebP, not {image.format}")
            if image.width * image.height > IMAGE_PIXELS:
                raise BadRequest(f"{name} has more than {IMAGE_PIXELS // 10**6} megapixels")
            upright = ImageOps.exif_transpose(image).convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError):
        raise BadRequest(f"{name} is not a decodable PNG, JPEG or WebP image") from None
    if not 0.25 <= upright.width / upright.height <= 4:
        raise BadRequest(f"{name}'s aspect ratio must be between 1:4 and 4:1")
    return upright


def canvas(pixels: int, aspect: float) -> tuple[int, int]:
    """Width and height in multiples of 64 near `pixels` in all, at the aspect ratio (width / height)."""
    width = max(64, round(math.sqrt(pixels * aspect) / 64) * 64)
    height = max(64, round(math.sqrt(pixels / aspect) / 64) * 64)
    return width, height


def faststart(raw: Path, final: Path, frames: int) -> None:
    """Moves the MP4's index to the front (playback before the download ends) and checks its streams."""
    done = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(raw), "-c", "copy",
                           "-movflags", "+faststart", "-y", str(final)], capture_output=True, text=True,
                          timeout=MUX_SECONDS)
    if done.returncode != 0:
        raise RuntimeError(f"ffmpeg: {done.stderr.strip()[-500:]}")
    probe = subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-show_entries",
                            "stream=codec_type,codec_name,nb_read_packets", "-of", "json", str(final)],
                           capture_output=True, text=True, check=True, timeout=MUX_SECONDS)
    streams = {s["codec_type"]: s for s in json.loads(probe.stdout)["streams"]}
    video, audio = streams.get("video", {}), streams.get("audio", {})
    if video.get("codec_name") != "h264" or audio.get("codec_name") != "aac":
        raise RuntimeError(f"the MP4 holds {video.get('codec_name')} video and {audio.get('codec_name')} audio")
    if int(video.get("nb_read_packets", 0)) != frames:
        raise RuntimeError(f"the MP4 has {video.get('nb_read_packets')} frames, {frames} expected")


def handler(server: Server) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            if not self.path.startswith(("/ready", "/health")):
                log.info("%s %s", self.command, format % args)

        def send(self, status: int, body: bytes, kind: str, headers: dict[str, str] | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def json(self, status: int, value: dict, headers: dict[str, str] | None = None) -> None:
            self.send(status, json.dumps(value).encode(), "application/json", headers)

        def error(self, status: int, message: str) -> None:
            kind = "invalid_request_error" if status < 500 else "server_error"
            self.json(status, {"error": {"message": message, "type": kind}})

        def route(self) -> tuple[Job | None, str | None]:
            """The job named by /v1/videos/{id}[/content] and the suffix; (None, None) for another path."""
            match = re.fullmatch(r"/v1/videos/([^/]+)(/content)?", self.path.split("?", 1)[0])
            if match is None:
                return None, None
            return server.store.get(match.group(1)), match.group(2) or ""

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path in ("/health", "/ready"):
                ready = server.status == "ready"
                return self.json(200 if path == "/health" or ready else 503, {"status": server.status})
            job, suffix = self.route()
            if suffix is None:
                return self.error(404, "not found")
            if job is None:
                return self.error(404, "video job not found")
            if suffix == "":
                return self.json(200, job.view())
            if job.status != "completed":
                return self.error(409, "video content is not ready")
            try:
                data = server.store.path(job, "output.mp4").read_bytes()
            except OSError:
                return self.error(503, "video content is unavailable")
            self.send(200, data, "video/mp4", {"Content-Disposition": f'attachment; filename="{job.id}.mp4"'})

        def body(self) -> bytes | None:
            """The request's body, plain or chunked; None when it is over BODY_BYTES."""
            if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                parts, size = [], 0
                while (length := int(self.rfile.readline().split(b";", 1)[0], 16)) > 0:
                    size += length
                    if size > BODY_BYTES:
                        return None
                    parts.append(self.rfile.read(length))
                    self.rfile.readline()
                while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                    pass
                return b"".join(parts)
            length = int(self.headers.get("Content-Length") or 0)
            return None if length > BODY_BYTES else self.rfile.read(length)

        def do_POST(self) -> None:
            raw = self.body()
            if raw is None:
                self.close_connection = True
                return self.error(413, f"the body is larger than {BODY_BYTES // 2**20} MiB")
            if self.path.split("?", 1)[0] != "/v1/videos":
                return self.error(404, "not found")
            if server.status != "ready":
                return self.error(503, "the model is still loading")
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self.error(400, "send the request as JSON (Content-Type: application/json)")
            try:
                job, keyframes = server.parse(json.loads(raw))
            except BadRequest as exc:
                return self.error(400, str(exc))
            except ValueError:
                return self.error(400, "the body is not valid JSON")
            server.store.add(job, keyframes)
            log.info("job %s queued: %s, %s s (%d frames), seed %d", job.id, job.size, job.seconds, job.frames,
                     job.seed)
            self.json(202, job.view(), {"Location": f"/v1/videos/{job.id}"})

        def do_DELETE(self) -> None:
            job, suffix = self.route()
            if suffix != "":
                return self.error(404, "not found")
            if job is None or server.store.delete(job.id) is None:
                return self.error(404, "video job not found")
            log.info("job %s deleted (was %s)", job.id, job.status)
            self.json(200, {"id": job.id, "object": "video.deleted", "deleted": True})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--models", type=Path, default=Path("/models/LTX-2.5"), help="the LTX-2.5 weights")
    # LTX-2's README: the diffusion decoder has "improved quality at the cost of longer decode time and more VRAM" and
    # is fastest with natten, which is CUDA-only (on ROCm it falls back to Triton or eager attention, untested here);
    # the convolutional one is "lighter and needs no extra dependencies".
    parser.add_argument("--video-vae", choices=VIDEO_VAES, default="conv", help="the video decoder (default: conv)")
    parser.add_argument("--root", type=Path, required=True, help="where jobs and their videos are kept")
    parser.add_argument("--ttl", type=int, default=3600, help="seconds a job is kept after it ends")
    parser.add_argument("--listen", default="127.0.0.1:18091", help="host:port")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    host, port = args.listen.rsplit(":", 1)
    server = Server(args)
    threading.Thread(target=server.serve, name="worker", daemon=True).start()
    httpd = ThreadingHTTPServer((host, int(port)), handler(server))
    httpd.daemon_threads = True
    log.info("listening on %s", args.listen)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
