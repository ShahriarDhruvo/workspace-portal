"""python3 -m unittest llm-server/apps/ming/test_ming_images.py

ming-images.py's HTTP side with torch and Ming-Image's code replaced by stand-ins: no GPU, weights or Ming venv,
only Pillow. The stand-in run_generation records each call and returns an RGBA image of the size asked for.
"""

import base64
import importlib.util
import io
import json
import socket
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


def stub(name: str, **attrs) -> types.ModuleType:
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

    memory_allocated = max_memory_allocated = staticmethod(lambda: 0)

    @classmethod
    def reset_peak_memory_stats(cls):
        cls.calls.append("reset_peak_memory_stats")


class Profile:
    def validate_task(self, task, has_reference_image, num_layers):
        assert (task, has_reference_image) == ("text-to-image", False)

    def resolve_sampling_parameters(self, steps, cfg):
        return SimpleNamespace(steps=12 if steps is None else steps, cfg=1.0 if cfg is None else cfg)


class Tokenizer:
    def __call__(self, text):
        return {"input_ids": text.split()}


class Ming:
    """infer.py's load_model_and_processor and run_generation."""

    tiling: dict = {}
    fail_load: Exception | None = None
    fail_run: Exception | None = None
    seconds = 0.0
    calls: list[dict] = []

    @classmethod
    def load_model_and_processor(cls, directory, options):
        if cls.fail_load:
            raise cls.fail_load
        assert (options.dtype, options.device, options.num_gpus) == ("bfloat16", "cuda:0", 1)
        cls.tiling = {}
        vae = SimpleNamespace(enable_tiling=lambda **sizes: cls.tiling.update(sizes))
        return SimpleNamespace(diffusion_loss=SimpleNamespace(vae=vae)), SimpleNamespace(tokenizer=Tokenizer())

    @classmethod
    def run_generation(cls, model, processor, profile, *, task, prompt, input_image, resolution, sampling, seed,
                       num_layers, dtype, width, height):
        assert (input_image, resolution) == (None, None)
        cls.calls.append({"task": task, "prompt": prompt, "steps": sampling.steps, "seed": seed, "width": width,
                          "height": height, "num_layers": num_layers})
        time.sleep(cls.seconds)
        if cls.fail_run:
            raise cls.fail_run
        image = Image.new("RGBA", (width, height), (10, 20, 30, 255))
        image.putpixel((0, 0), (0, 0, 0, 0))
        return [image]


stub("torch", cuda=Cuda, bfloat16="bfloat16")
stub("infer", load_model_and_processor=Ming.load_model_and_processor, run_generation=Ming.run_generation)
stub("inference_profile", load_checkpoint_capabilities=lambda directory: Profile())

_spec = importlib.util.spec_from_file_location("ming_images", Path(__file__).with_name("ming-images.py"))
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

GOOD = {"model": "Ming-Image-0.2-Design", "prompt": "a red ceramic teapot on a wooden table"}


def decode(entry) -> Image.Image:
    image = Image.open(io.BytesIO(base64.b64decode(entry["b64_json"])))
    image.load()
    return image


class Weights(unittest.TestCase):
    """The model's files, empty, in a temporary folder."""

    def setUp(self):
        Cuda.available, Cuda.calls[:] = True, []
        Ming.fail_load = Ming.fail_run = None
        Ming.seconds, Ming.calls[:] = 0.0, []
        self.models = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for file in M.FILES:
            (self.models / file).parent.mkdir(parents=True, exist_ok=True)
            (self.models / file).touch()


class LoadFails(Weights):
    def died(self) -> str:
        """Loads the model, which must end the process with status 1; returns what it logged."""
        with mock.patch.object(M.os, "_exit", side_effect=SystemExit) as leave, \
                self.assertLogs("ming-images", "ERROR") as logs, self.assertRaises(SystemExit):
            M.Server(SimpleNamespace(model=self.models)).load()
        leave.assert_called_once_with(1)
        return "\n".join(logs.output)

    def test_missing_weights(self):
        (self.models / "mlp/model.safetensors").unlink()
        self.assertIn(f"weights are missing: 1 of {len(M.FILES)} files not in {self.models} (mlp/model.safetensors)",
                      self.died())
        self.assertEqual(Cuda.calls, [], "the GPU is touched only once the weights are there")

    def test_no_gpu(self):
        Cuda.available = False
        self.assertIn("no ROCm GPU visible", self.died())

    def test_the_engine_fails(self):
        Ming.fail_load = RuntimeError("HIP out of memory")
        self.assertIn("HIP out of memory", self.died())


class Generations(Weights):
    """One ming-images server on an ephemeral port."""

    def setUp(self):
        super().setUp()
        self.server = M.Server(SimpleNamespace(model=self.models))
        self.server.load()
        self.httpd = M.ThreadingHTTPServer(("127.0.0.1", 0), M.handler(self.server))
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.port = self.httpd.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        Cuda.calls[:] = []

    def call(self, method, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers=headers or ({"Content-Type": "application/json"} if data else {}))
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b"null")

    def generate(self, **fields):
        status, answer = self.call("POST", "/v1/images/generations", {**GOOD, **fields})
        self.assertEqual(status, 200, answer)
        return [decode(entry) for entry in answer["data"]]

    def hang_up(self, body: dict, after: float) -> None:
        """Sends a generation request and closes the connection `after` seconds later, without reading."""
        data = json.dumps(body).encode()
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as sock:
            sock.sendall(b"POST /v1/images/generations HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                         b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data)
            time.sleep(after)

    def test_ready_and_models(self):
        self.assertEqual(self.call("GET", "/ready"), (200, {"status": "ready"}))
        self.assertEqual(self.call("GET", "/health"), (200, {"status": "ready"}))
        self.assertEqual(Ming.tiling, {"tile_sample_min_height": 1024, "tile_sample_min_width": 1024,
                                       "tile_sample_stride_height": 896, "tile_sample_stride_width": 896})
        status, answer = self.call("GET", "/v1/models")
        self.assertEqual((status, [m["id"] for m in answer["data"]]), (200, ["Ming-Image-0.2-Design"]))

    def test_while_the_model_loads(self):
        self.server.status = "loading"
        self.assertEqual(self.call("GET", "/ready"), (503, {"status": "loading"}))
        self.assertEqual(self.call("GET", "/health"), (200, {"status": "loading"}))
        self.assertEqual(self.call("POST", "/v1/images/generations", GOOD)[0], 503)

    def test_auto_size_and_a_random_seed(self):
        [image] = self.generate()
        self.assertEqual((image.format, image.mode, image.size), ("PNG", "RGBA", (1024, 1024)))
        [call] = Ming.calls
        self.assertEqual((call["task"], call["width"], call["height"], call["steps"]), ("text-to-image", 1024, 1024, 12))
        self.assertTrue(0 <= call["seed"] < 2**32)
        self.assertEqual(call["prompt"], GOOD["prompt"])

    def test_n_size_seed_and_steps(self):
        images = self.generate(n=3, size="1344x768", seed=5, steps=20, quality="high")
        self.assertEqual([image.size for image in images], [(1344, 768)] * 3)
        self.assertEqual([call["seed"] for call in Ming.calls], [5, 6, 7])
        self.assertEqual({(call["width"], call["height"], call["steps"]) for call in Ming.calls}, {(1344, 768, 20)})

    def test_memory_is_given_back_after_each_image(self):
        self.generate(n=2)
        self.assertEqual(Cuda.calls, ["reset_peak_memory_stats", "empty_cache"] * 2)

    def test_seeds_wrap(self):
        self.generate(n=2, seed=2**32 - 1)
        self.assertEqual([call["seed"] for call in Ming.calls], [2**32 - 1, 0])

    def test_opaque_background(self):
        [image] = self.generate(background="opaque")
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(image.getpixel((0, 0)), (255, 255, 255), "a transparent pixel on white")
        [image] = self.generate(background="transparent")
        self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_bad_requests(self):
        bad = [
            ({**GOOD, "model": "Qwen-Image-2.1"}, "model must be Ming-Image-0.2-Design"),
            ({"model": GOOD["model"]}, "prompt is required"),
            ({**GOOD, "prompt": "  "}, "prompt is required"),
            ({**GOOD, "prompt": ["a teapot"]}, "prompt is required"),
            ({**GOOD, "prompt": "word " * 8193}, "longer than 8192 tokens"),
            ({**GOOD, "response_format": "url"}, "b64_json"),
            ({**GOOD, "response_format": {"type": "png"}}, "b64_json"),
            ({**GOOD, "negative_prompt": "blur"}, "no negative conditioning"),
            ({**GOOD, "background": "black"}, "background must be one of"),
            ({**GOOD, "background": ["opaque"]}, "background must be one of"),
            ({**GOOD, "n": 0}, "n must be an integer from 1 to 10"),
            ({**GOOD, "n": 11}, "n must be"),
            ({**GOOD, "n": True}, "n must be"),
            ({**GOOD, "n": 1.5}, "n must be"),
            ({**GOOD, "n": "2"}, "n must be"),
            ({**GOOD, "steps": 1}, "steps must be an integer from 2 to 100"),
            ({**GOOD, "seed": -1}, "seed must be"),
            ({**GOOD, "seed": 2**32}, "seed must be"),
            ({**GOOD, "seed": [7]}, "seed must be"),
            ({**GOOD, "size": "1024"}, 'size must be "auto" or WIDTHxHEIGHT'),
            ({**GOOD, "size": 1024}, "size must be"),
            ({**GOOD, "size": {"width": 1024}}, "size must be"),
            ({**GOOD, "size": "1000x1000"}, "multiple of 16"),
            ({**GOOD, "size": "128x128"}, "from 256 to 4096"),
            ({**GOOD, "size": "2560x2560"}, "at most 4.5 megapixels"),
            ({**GOOD, "size": "4096x256"}, "aspect ratio"),
            ({**GOOD, "image": "data:image/png;base64,AAAA"}, "makes new images only"),
            ([GOOD], "JSON object"),
        ]
        for body, words in bad:
            with self.subTest(words=words, body=str(body)[:80]):
                status, answer = self.call("POST", "/v1/images/generations", body)
                self.assertEqual(status, 400, answer)
                self.assertEqual(answer["error"]["type"], "invalid_request_error")
                self.assertIn(words, answer["error"]["message"])
        self.assertEqual(Ming.calls, [], "no bad request reached the model")

    def test_edits_are_refused(self):
        status, answer = self.call("POST", "/v1/images/edits", {**GOOD, "image": "data:image/png;base64,AAAA"})
        self.assertEqual((status, answer["error"]["type"]), (404, "invalid_request_error"))
        self.assertIn("Ming-Image-0.2-Design makes new images only", answer["error"]["message"])
        self.assertEqual(Ming.calls, [])

    def test_other_errors(self):
        for raw in (b"{not json", b"[" * 200_000, b'{"prompt": "\xff"}'):
            status, answer = self.call("POST", "/v1/images/generations", raw=raw,
                                       headers={"Content-Type": "application/json"})
            self.assertEqual((status, answer["error"]["message"]), (400, "the body is not valid JSON"), raw[:20])
        status, answer = self.call("POST", "/v1/images/generations", raw=b"prompt=x",
                                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 400)
        self.assertIn("as JSON", answer["error"]["message"])
        self.assertEqual(self.call("GET", "/v1/other")[0], 404)
        self.assertEqual(self.call("POST", "/v1/other", GOOD)[0], 404)
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as sock:
            sock.sendall(b"POST /v1/images/generations HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                         b"Content-Length: 70000000\r\n\r\n")
            self.assertTrue(sock.recv(100).startswith(b"HTTP/1.1 413"))

    def test_a_failed_generation(self):
        Ming.fail_run = RuntimeError("HIP error: invalid device function")
        status, answer = self.call("POST", "/v1/images/generations", GOOD)
        self.assertEqual(status, 500)
        self.assertIn("generation failed: HIP error", answer["error"]["message"])
        self.assertEqual(Cuda.calls[-2:], ["reset_peak_memory_stats", "empty_cache"], "what it took is given back")
        Ming.fail_run = None
        self.generate()

    def test_a_client_that_hangs_up_gets_no_more_images(self):
        Ming.seconds = 0.3
        self.hang_up({**GOOD, "n": 3}, after=0.1)
        time.sleep(1.0)
        self.assertEqual(len(Ming.calls), 1)

    def test_a_client_that_hangs_up_while_it_waits_gets_no_image(self):
        Ming.seconds = 0.4
        first = threading.Thread(target=self.generate, kwargs={"seed": 1})
        first.start()
        time.sleep(0.1)
        self.hang_up({**GOOD, "seed": 2}, after=0.1)
        first.join()
        time.sleep(0.2)
        self.assertEqual([call["seed"] for call in Ming.calls], [1])

    def test_one_image_at_a_time(self):
        Ming.seconds = 0.2
        threads = [threading.Thread(target=self.generate) for _ in range(3)]
        started = time.monotonic()
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertGreaterEqual(time.monotonic() - started, 0.6)
        self.assertEqual(len(Ming.calls), 3)


if __name__ == "__main__":
    unittest.main()
