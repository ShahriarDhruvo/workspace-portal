"""OpenAI-style speech endpoint for Fish Audio Drama 3, on fish-speech's own inference engine, in one process.

POST /v1/audio/speech, JSON:
  model            "fish-drama-3" (required; any other is refused)
  input            the text, with inline tags such as [whisper] or [laughing] (required)
  response_format  "wav" (the default and the only format)
  reference_audio  a voice to clone: base64 of a WAV, FLAC or MP3 file, or a data:audio/...;base64, URL
  reference_text   the transcript of reference_audio (optional, but the model was trained with one)
  seed, temperature, top_p, max_new_tokens, chunk_length  fish-speech's sampling options, checked by fish-speech
Answers audio/wav (16-bit mono), or an OpenAI error {"error": {"message", "type"}}.
GET /ready is 200 once the model is loaded and warmed up, else 503 (llama-swap's health check); GET /health is
200 while the process runs.

install.sh puts this file in the root of the fish-speech checkout, where fish_speech and tools import from:
  .venv/bin/python fish-speech-openai.py --checkpoint /models/fishaudio-drama-3 --listen 127.0.0.1:18084
"""

import argparse
import base64
import binascii
import io
import json
import re
import select
import socket
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import soundfile as sf
import torch
from loguru import logger
from pydantic import ValidationError

from fish_speech.inference_engine import TTSInferenceEngine
from fish_speech.models.text2semantic.errors import InvalidInputError
from fish_speech.utils.schema import ServeReferenceAudio, ServeTTSRequest
from tools.server.model_manager import ModelManager

MODEL = "fish-drama-3"
SAMPLING_FIELDS = ("seed", "temperature", "top_p", "max_new_tokens", "chunk_length")
DATA_URL = re.compile(r"^data:audio/[\w.+-]+;base64,")

engine: TTSInferenceEngine | None = None
# One synthesis at a time: fish-speech's model worker is single, and the codec decodes on the request's thread.
synthesis = threading.Lock()


class RequestError(Exception):
    """A request the client has to change; answered with 400."""


class Gone(Exception):
    """The client hung up while its request waited for its turn."""


def reference(audio: Any, text: Any) -> list[ServeReferenceAudio]:
    if audio is None:
        if text is not None:
            raise RequestError("reference_text needs reference_audio")
        return []
    if not isinstance(audio, str) or not isinstance(text, str | None):
        raise RequestError("reference_audio and reference_text must be strings")
    try:
        data = base64.b64decode(DATA_URL.sub("", audio, count=1), validate=True)
        sf.info(io.BytesIO(data))
    except (binascii.Error, sf.LibsndfileError) as error:
        raise RequestError(f"reference_audio is not base64 of a WAV, FLAC or MP3 file: {error}") from error
    return [ServeReferenceAudio(audio=data, text=text or "")]


def tts_request(body: Any) -> ServeTTSRequest:
    if not isinstance(body, dict):
        raise RequestError("the body must be a JSON object")
    if body.get("model") != MODEL:
        raise RequestError(f"model must be {MODEL!r}")
    text = body.get("input")
    if not isinstance(text, str) or not text.strip():
        raise RequestError("input must be non-empty text")
    if body.get("response_format", "wav") != "wav":
        raise RequestError("response_format must be 'wav'")
    sampling = {name: body[name] for name in SAMPLING_FIELDS if body.get(name) is not None}
    try:
        return ServeTTSRequest(
            text=text,
            format="wav",
            references=reference(body.get("reference_audio"), body.get("reference_text")),
            **sampling,
        )
    except ValidationError as error:
        raise RequestError(
            "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in error.errors())
        ) from error


def synthesize(model: TTSInferenceEngine, request: ServeTTSRequest, gone) -> bytes:
    with synthesis:
        # Checked after the wait for its turn, during which the client may have hung up.
        if gone():
            raise Gone()
        for result in model.inference(request):
            if result.code == "error":
                if isinstance(result.error, InvalidInputError):
                    raise RequestError(str(result.error))
                raise result.error or RuntimeError("fish-speech failed without an error")
            if result.code == "final" and result.audio is not None:
                sample_rate, audio = result.audio
                wav = io.BytesIO()
                sf.write(wav, audio, sample_rate, format="WAV", subtype="PCM_16")
                return wav.getvalue()
    raise RuntimeError("fish-speech returned no audio")


def error_body(message: str, kind: str) -> bytes:
    return json.dumps({"error": {"message": message, "type": kind}}).encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send(self, status: HTTPStatus, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def gone(self) -> bool:
        """The client closed its connection (it sends nothing else while it waits)."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self.send(HTTPStatus.OK, b'{"status":"ok"}')
        elif path == "/ready":
            ready = engine is not None
            self.send(
                HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE,
                b'{"status":"ready"}' if ready else b'{"status":"loading"}',
            )
        else:
            self.send(HTTPStatus.NOT_FOUND, error_body(f"no route {path}", "invalid_request_error"))

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path = self.path.split("?", 1)[0]
        if path != "/v1/audio/speech":
            self.send(HTTPStatus.NOT_FOUND, error_body(f"no route {path}", "invalid_request_error"))
            return
        if engine is None:
            self.send(HTTPStatus.SERVICE_UNAVAILABLE, error_body("the model is still loading", "server_error"))
            return
        try:
            request = tts_request(json.loads(body))
            audio = synthesize(engine, request, self.gone)
        except Gone:
            logger.info("the client hung up; nothing is synthesized")
            self.close_connection = True
            return
        except (RequestError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.send(HTTPStatus.BAD_REQUEST, error_body(str(error), "invalid_request_error"))
            return
        except Exception:
            logger.exception("synthesis failed")
            self.send(HTTPStatus.INTERNAL_SERVER_ERROR, error_body("synthesis failed", "server_error"))
            return
        self.send(HTTPStatus.OK, audio, "audio/wav")


def main() -> None:
    global engine
    parser = argparse.ArgumentParser(description="OpenAI-style speech endpoint for Fish Audio Drama 3")
    parser.add_argument("--checkpoint", type=Path, required=True, help="Drama 3 directory, with codec.pth")
    parser.add_argument("--listen", default="127.0.0.1:18084", help="host:port")
    args = parser.parse_args()
    host, port = args.listen.rsplit(":", 1)

    server = ThreadingHTTPServer((host, int(port)), Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    if not torch.cuda.is_available():
        raise SystemExit("torch sees no GPU; Drama 3 runs on a GPU only")
    logger.info(f"GPU: {torch.cuda.get_device_name(0)} ({torch.cuda.get_device_properties(0).gcnArchName})")
    manager = ModelManager(
        mode="tts",
        device="cuda",
        half=False,
        compile=False,
        llama_checkpoint_path=str(args.checkpoint),
        decoder_checkpoint_path=None,
        decoder_config_name="modded_dac_vq",
    )
    engine = manager.tts_inference_engine
    logger.info(f"ready on http://{args.listen}")
    serving.join()


if __name__ == "__main__":
    main()
