"""Ming-Image-0.2-Design behind the OpenAI Images API, as Gufo serves Qwen-Image-2.1, so OpenCode's generate_image
and the portal's gateway use it as they used Gufo's image models.

  POST /v1/images/generations  JSON: model, prompt, n, size, seed, steps, background, response_format
  GET  /v1/models              the model
  GET  /ready                  200 once the model is loaded (llama-swap's check)
  GET  /health                 200 while the process runs, with the status: loading or ready

Ming-Image makes new images only: POST /v1/images/edits answers 404 and says so, and an `image` in a generation
request answers 400.

model must be MODEL_ID. size is "auto" (the default: 1024x1024) or WIDTHxHEIGHT, each side a multiple of 16 from 256
to 4096, at most 4.5 megapixels, 1:4 to 4:1. Ming makes an image at its 1024 or 2048 level (2048 from about
1536x1536 up; it takes about six times as long) and resizes it to the size asked for. n is 1 to 10 images, made one
after another, the second with seed + 1 and so on; seed is random if left out. steps is 2 to 100, default 12 (the
model card's). background "opaque" puts the image on white; "auto" and "transparent" keep the alpha channel Ming
makes (ask for a transparent background in the prompt). Output is base64 PNG; response_format "url" and a non-empty
negative_prompt (Ming has no negative conditioning) answer 400. Unknown fields are ignored, as Gufo does. Errors are
{"error": {"message", "type"}}. One image is made at a time; requests wait in turn, and a request whose client hung
up stops before its next image. Prompts are never logged.

When the weights are missing or loading fails, the server logs the reason and exits with status 1. ming.service has
Restart=no, so systemd does not start it again, and llama-swap sees the unit end and fails the request at once. A
server left up with /ready at 503 would keep the LLM stopped until llama-swap's healthCheckTimeout, on every request.

install.sh puts this file in the root of the Ming-Image checkout, whose infer.py it drives in-process; ming.service
runs it with that venv's Python.
"""

import argparse
import base64
import io
import json
import logging
import os
import re
import secrets
import select
import socket
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import torch
from PIL import Image

import infer
from inference_profile import load_checkpoint_capabilities

MODEL_ID = "Ming-Image-0.2-Design"
SIZE = re.compile(r"([1-9][0-9]{2,3})x([1-9][0-9]{2,3})")
SIDE_MIN, SIDE_MAX = 256, 4096
PIXELS_MAX = 4_500_000
# Generation at size auto; Ming's own default is 2048x2048, which takes about six times as long (191 s, not 30).
AUTO_SIZE = (1024, 1024)
# The VAE decodes an image larger than 1024 pixels on a side in overlapping tiles of 1024, 896 apart: at 2048x2048
# it then takes 2.3 GiB beside the weights instead of 35, and the image differs from the untiled one by 0.12 of 255
# on average. Smaller images are decoded whole, as before.
VAE_TILE, VAE_STRIDE = 1024, 896
N_MAX = 10
STEPS_MIN, STEPS_MAX = 2, 100
SEED_LIMIT = 2**32
# The prompt's tokens: the language model attends eagerly (BailingMoeV2 has no SDPA path), so its memory grows with
# the square of the prompt.
PROMPT_TOKENS = 8192
# Room for an image edit sent here by mistake: it is read whole, so its sender gets the answer that says so.
BODY_BYTES = 32 * 1024 * 1024
BACKGROUNDS = ("auto", "opaque", "transparent")
# Every file the model loads, by component: config.json and the weights' index or file.
FILES = [
    "config.json", "mllm/config.json", "mllm/model.safetensors.index.json", "mllm/tokenizer.json",
    "mlp/config.json", "mlp/model.safetensors", "connector/config.json", "connector/model.safetensors.index.json",
    "transformer/config.json", "transformer/diffusion_pytorch_model.safetensors.index.json",
    "vae/config.json", "vae/diffusion_pytorch_model.safetensors", "scheduler/scheduler_config.json",
]

log = logging.getLogger("ming-images")


class BadRequest(Exception):
    """A request the client has to change; answered with 400."""


class Gone(Exception):
    """The client hung up before the request's last image."""


def image_size(value: Any) -> tuple[int, int] | None:
    """WIDTHxHEIGHT as a pair, None for auto."""
    if value is None or value == "auto":
        return None
    match = SIZE.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise BadRequest('size must be "auto" or WIDTHxHEIGHT, such as 1024x1024')
    width, height = int(match.group(1)), int(match.group(2))
    if not (SIDE_MIN <= width <= SIDE_MAX and SIDE_MIN <= height <= SIDE_MAX) or width % 16 or height % 16:
        raise BadRequest(f"each side of size must be a multiple of 16 from {SIDE_MIN} to {SIDE_MAX}")
    if width * height > PIXELS_MAX:
        raise BadRequest(f"size must be at most {PIXELS_MAX / 10**6:g} megapixels")
    if not 0.25 <= width / height <= 4:
        raise BadRequest("size's aspect ratio must be between 1:4 and 4:1")
    return width, height


def integer(name: str, value: Any, low: int, high: int, default: int | None) -> int | None:
    """An integer field of the request."""
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise BadRequest(f"{name} must be an integer from {low} to {high}")
    return value


class Server:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.status = "loading"
        self.model = self.processor = self.profile = None
        self.gpu = threading.Lock()

    def load(self) -> None:
        """Loads the model onto the GPU; any failure ends the process so systemd and llama-swap see it."""
        started = time.monotonic()
        directory = self.args.model
        try:
            missing = [name for name in FILES if not (directory / name).is_file()]
            if missing:  # checked before the GPU is touched
                raise RuntimeError(
                    f"the Ming-Image-0.2-Design weights are missing: {len(missing)} of {len(FILES)} files not in "
                    f"{directory} ({', '.join(missing)}); download them (docs/GUIDE.md)")
            if not torch.cuda.is_available():
                raise RuntimeError("no ROCm GPU visible to torch")
            self.profile = load_checkpoint_capabilities(directory)
            self.profile.validate_task("text-to-image", has_reference_image=False, num_layers=1)
            # infer.py's defaults: BF16, the model card's precision, everything on the one GPU.
            options = types.SimpleNamespace(processor=None, dtype="bfloat16", attn_implementation="eager",
                                            device="cuda:0", device_map="balanced", num_gpus=1)
            self.model, self.processor = infer.load_model_and_processor(directory, options)
            self.model.diffusion_loss.vae.enable_tiling(
                tile_sample_min_height=VAE_TILE, tile_sample_min_width=VAE_TILE,
                tile_sample_stride_height=VAE_STRIDE, tile_sample_stride_width=VAE_STRIDE)
        except BaseException:
            log.exception("loading failed")
            os._exit(1)  # sys.exit would end only this thread
        self.status = "ready"
        log.info("ready in %.1f s; %.1f GiB of GPU memory in use", time.monotonic() - started,
                 torch.cuda.memory_allocated() / 2**30)

    def parse(self, body: Any) -> dict:
        """A request's settings, checked, with the defaults filled in."""
        if not isinstance(body, dict):
            raise BadRequest("the body must be a JSON object")
        if body.get("model") != MODEL_ID:
            raise BadRequest(f"model must be {MODEL_ID}")
        if body.get("image") is not None:
            raise BadRequest(f"{MODEL_ID} makes new images only: it cannot change the image sent")
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise BadRequest("prompt is required")
        if len(self.processor.tokenizer(prompt)["input_ids"]) > PROMPT_TOKENS:
            raise BadRequest(f"prompt is longer than {PROMPT_TOKENS} tokens")
        if body.get("response_format", "b64_json") not in (None, "b64_json"):
            raise BadRequest('response_format must be "b64_json": images are returned as base64 PNG')
        if body.get("negative_prompt"):
            raise BadRequest("negative_prompt is not supported: Ming-Image has no negative conditioning")
        background = body.get("background") or "auto"
        if background not in BACKGROUNDS:
            raise BadRequest(f"background must be one of {', '.join(BACKGROUNDS)}")
        return {
            "prompt": prompt, "size": image_size(body.get("size")),
            "n": integer("n", body.get("n"), 1, N_MAX, 1),
            "steps": integer("steps", body.get("steps"), STEPS_MIN, STEPS_MAX, None),
            "seed": integer("seed", body.get("seed"), 0, SEED_LIMIT - 1, None), "background": background,
        }

    def render(self, req: dict, seed: int, gone) -> tuple[Image.Image, float]:
        """One image as Ming made it, at the size asked for, and the GPU memory it took at most, in GiB."""
        sampling = self.profile.resolve_sampling_parameters(steps=req["steps"], cfg=None)
        width, height = req["size"] or AUTO_SIZE
        with self.gpu:
            # Checked after the wait for the GPU, during which the client may have hung up.
            if gone():
                raise Gone()
            torch.cuda.reset_peak_memory_stats()
            try:
                images = infer.run_generation(self.model, self.processor, self.profile, task="text-to-image",
                                              prompt=req["prompt"], input_image=None, resolution=None, width=width,
                                              height=height, sampling=sampling, seed=seed, num_layers=1,
                                              dtype=torch.bfloat16)
                peak = torch.cuda.max_memory_allocated() / 2**30
            finally:
                # PyTorch would keep what the image took, about 7 GiB beside the weights, for the next one; a speech
                # model running beside this server needs it more.
                torch.cuda.empty_cache()
        return images[0], peak

    def generate(self, req: dict, gone) -> list[str]:
        """The request's images as base64 PNG."""
        first = secrets.randbelow(SEED_LIMIT) if req["seed"] is None else req["seed"]
        results = []
        for index in range(req["n"]):
            started = time.monotonic()
            seed = (first + index) % SEED_LIMIT
            image, peak = self.render(req, seed, gone)
            if req["background"] == "opaque":
                image = Image.alpha_composite(Image.new("RGBA", image.size, "white"), image.convert("RGBA"))
                image = image.convert("RGB")
            out = io.BytesIO()
            image.save(out, format="PNG")
            results.append(base64.b64encode(out.getvalue()).decode("ascii"))
            log.info("image %d of %d: %dx%d, %s steps, seed %d, took %.1f s and %.1f GiB at most", index + 1,
                     req["n"], image.width, image.height, req["steps"] or "default", seed,
                     time.monotonic() - started, peak)
        return results


def handler(server: Server) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            if not self.path.startswith(("/ready", "/health")):
                log.info("%s %s", self.command, format % args)

        def send(self, status: int, body: bytes, kind: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def json(self, status: int, value: dict) -> None:
            self.send(status, json.dumps(value).encode(), "application/json")

        def error(self, status: int, message: str) -> None:
            kind = "invalid_request_error" if status < 500 else "server_error"
            self.json(status, {"error": {"message": message, "type": kind}})

        def gone(self) -> bool:
            """The client closed its connection (it sends nothing else while it waits)."""
            try:
                readable, _, _ = select.select([self.connection], [], [], 0)
                return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
            except OSError:
                return True

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path in ("/health", "/ready"):
                ready = server.status == "ready"
                return self.json(200 if path == "/health" or ready else 503, {"status": server.status})
            if path == "/v1/models":
                return self.json(200, {"object": "list", "data": [
                    {"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "inclusionAI"}]})
            self.error(404, "not found")

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
            path = self.path.split("?", 1)[0]
            if path == "/v1/images/edits":
                return self.error(404, f"{MODEL_ID} makes new images only: it has no /v1/images/edits")
            if path != "/v1/images/generations":
                return self.error(404, "not found")
            if server.status != "ready":
                return self.error(503, "the model is still loading")
            try:
                if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                    raise BadRequest("send the request as JSON (Content-Type: application/json)")
                try:
                    body = json.loads(raw)
                except (ValueError, RecursionError):
                    raise BadRequest("the body is not valid JSON") from None
                req = server.parse(body)
            except BadRequest as exc:
                return self.error(400, str(exc))
            try:
                data = server.generate(req, self.gone)
            except Gone:
                log.info("the client hung up; the rest of its images are not made")
                self.close_connection = True
                return None
            except Exception as exc:
                log.exception("generation failed")
                return self.error(500, f"generation failed: {exc}")
            self.json(200, {"created": int(time.time()), "data": [{"b64_json": entry} for entry in data]})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--model", type=Path, default=Path("/models/Ming-Image-0.2-Design"), help="the weights")
    parser.add_argument("--listen", default="127.0.0.1:18081", help="host:port")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    host, port = args.listen.rsplit(":", 1)
    server = Server(args)
    threading.Thread(target=server.load, name="load", daemon=True).start()
    httpd = ThreadingHTTPServer((host, int(port)), handler(server))
    httpd.daemon_threads = True
    log.info("listening on %s", args.listen)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
