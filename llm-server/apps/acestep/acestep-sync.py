"""ACE-Step 1.5 XL behind one synchronous route: POST /v1/audio/music answers with the finished track's bytes.

Runs with ACE-Step's venv from the root of its checkout (install.sh copies it there), so it imports ACE-Step from the
source tree, and drives its Python API in-process: both XL DiTs load at start, and the request's `model` picks one:
acestep-1.5-xl-base for final tracks, acestep-1.5-xl-turbo for quick ones (one llama-swap entry, the second name its
alias, so both reach this one process). One track is generated at a time; a request whose client hung up while it
waited gets none. GET /ready answers 200 once both can generate (llama-swap's health check); GET /health always
answers. acestep.service runs it.
"""

import io
import os
import subprocess
import sys
import tempfile
import threading
import time

import soundfile as sf
import torch
import uvicorn
from anyio import from_thread
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from loguru import logger
from starlette.concurrency import run_in_threadpool

import acestep
from acestep.audio_utils import normalize_audio
from acestep.constants import DURATION_MAX, DURATION_MIN
from acestep.handler import AceStepHandler
from acestep.inference import GenerationConfig, GenerationParams, generate_music
from acestep.model_downloader import check_main_model_exists, check_model_exists, get_checkpoints_dir

HOST, PORT = "127.0.0.1", 18086
# The model a request names: True for the turbo DiT.
MODELS = {"acestep-1.5-xl-base": False, "acestep-1.5-xl-turbo": True}
# Sampler settings per DiT: base at the 50 steps of its model card with CFG, turbo at its 8 distilled steps. Shift 3
# and DCW on turbo only are the defaults of ACE-Step's own UI and API for these models.
DITS = {
    False: {"config_path": "acestep-v15-xl-base", "inference_steps": 50, "guidance_scale": 7.0, "shift": 3.0,
            "dcw_enabled": False},
    True: {"config_path": "acestep-v15-xl-turbo", "inference_steps": 8, "guidance_scale": 1.0, "shift": 3.0,
           "dcw_enabled": True},
}
FORMATS = {"wav": "audio/wav", "flac": "audio/flac", "mp3": "audio/mpeg"}
FIELDS = {"model", "prompt", "lyrics", "duration", "seed", "response_format"}
# ACE-Step's documented input limits (docs/en/INFERENCE.md); longer text would be cut by its tokenizers unseen.
PROMPT_MAX, LYRICS_MAX = 512, 4096
# Peak of a decoded track before normalization: measured 0.11 to 1.0 for music, 0.0013 to 0.0036 for near-silence.
MIN_PEAK = 0.05
# ACE-Step's default output peak (GenerationParams.normalization_db).
NORMALIZE_DB = -1.0
# ffmpeg's time for the MP3. LAME encodes many times faster than a track plays, so one that takes this long has hung,
# and the request fails.
MP3_SECONDS = 120

handlers: dict[bool, AceStepHandler] = {}
state = {"status": "loading"}
gpu = threading.Lock()


class BadRequest(Exception):
    pass


class Gone(Exception):
    """The client hung up before its track was started."""


def error(status: int, message: str, kind: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": kind}}, status_code=status)


def parse(body: object) -> dict:
    """The request's fields, checked, with defaults filled in."""
    if not isinstance(body, dict):
        raise BadRequest("the body must be a JSON object")
    unknown = sorted(set(body) - FIELDS)
    if unknown:
        raise BadRequest(f"unknown field(s): {', '.join(unknown)}")
    model = body.get("model")
    if model not in MODELS:
        raise BadRequest(f"model must be one of {', '.join(MODELS)}")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise BadRequest("prompt is required: the style or tags of the track")
    if len(prompt) > PROMPT_MAX:
        raise BadRequest(f"prompt is longer than {PROMPT_MAX} characters")
    lyrics = body.get("lyrics", "[Instrumental]")
    if not isinstance(lyrics, str) or len(lyrics) > LYRICS_MAX:
        raise BadRequest(f"lyrics must be a string of at most {LYRICS_MAX} characters")
    duration = body.get("duration")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not (
        DURATION_MIN <= duration <= DURATION_MAX
    ):
        raise BadRequest(f"duration is required: seconds from {DURATION_MIN} to {DURATION_MAX}")
    seed = body.get("seed")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**32):
        raise BadRequest("seed must be an integer from 0 to 4294967295")
    response_format = body.get("response_format", "wav")
    if response_format not in FORMATS:
        raise BadRequest(f"response_format must be one of {', '.join(FORMATS)}")
    return {"prompt": prompt, "lyrics": lyrics.strip() or "[Instrumental]", "duration": float(duration),
            "draft": MODELS[model], "seed": seed, "response_format": response_format}


def encode(wav: torch.Tensor, sample_rate: int, response_format: str) -> bytes:
    """16-bit WAV or FLAC by libsndfile, VBR MP3 (LAME -V2) by ffmpeg from that WAV."""
    if response_format == "mp3":
        # Into a file, not a pipe: ffmpeg writes the VBR header, which gives players the length, only into a file.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "track.mp3")
            done = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
                 "-codec:a", "libmp3lame", "-q:a", "2", path],
                input=encode(wav, sample_rate, "wav"), capture_output=True, timeout=MP3_SECONDS,
            )
            if done.returncode != 0:
                raise RuntimeError(f"ffmpeg: {done.stderr.decode(errors='replace').strip()}")
            with open(path, "rb") as f:
                return f.read()
    out = io.BytesIO()
    sf.write(out, wav.clamp(-1.0, 1.0).T.numpy(), sample_rate, format=response_format.upper(), subtype="PCM_16")
    return out.getvalue()


def render(req: dict, gone) -> tuple[torch.Tensor, int, int]:
    """One track as ACE-Step decoded it, not yet normalized: waveform [channels, samples], sample rate and seed."""
    dit = DITS[req["draft"]]
    seed = req["seed"]
    params = GenerationParams(
        task_type="text2music", caption=req["prompt"], lyrics=req["lyrics"], duration=req["duration"],
        inference_steps=dit["inference_steps"], guidance_scale=dit["guidance_scale"], shift=dit["shift"],
        dcw_enabled=dit["dcw_enabled"], seed=-1 if seed is None else seed, enable_normalization=False,
        thinking=False, use_cot_metas=False, use_cot_caption=False, use_cot_language=False,
    )
    config = GenerationConfig(batch_size=1, use_random_seed=seed is None, seeds=None if seed is None else [seed])
    with gpu:
        # Checked after the wait for the GPU, during which the client may have hung up.
        if gone():
            raise Gone()
        result = generate_music(handlers[req["draft"]], None, params, config, save_dir=None)
    if not result.success:
        raise RuntimeError(result.error or result.status_message or "generation failed")
    if len(result.audios) != 1 or result.audios[0].get("tensor") is None:
        raise RuntimeError(f"expected one track, got {len(result.audios)}")
    audio = result.audios[0]
    wav = audio["tensor"].float()
    if not torch.isfinite(wav).all():
        raise RuntimeError("the model produced NaN or infinite samples")
    return wav, audio["sample_rate"], audio["params"]["seed"]


def generate(req: dict, gone) -> bytes:
    """One track, peak-normalized like ACE-Step's own output and encoded."""
    started = time.monotonic()
    # Some prompt and seed pairs give near-silence, which normalizing would turn into a full-scale DC level. Without
    # a chosen seed, a second seed is tried.
    for _ in range(1 if req["seed"] is not None else 2):
        wav, sample_rate, seed = render(req, gone)
        peak = wav.abs().max().item()
        if peak >= MIN_PEAK:
            break
        logger.warning("near-silent track: draft={} duration={:.0f}s seed={} peak={:.4f}",
                       req["draft"], req["duration"], seed, peak)
    else:
        raise RuntimeError(f"the model produced near-silence (peak {peak:.4f}) with seed {seed}; try another seed")
    wav = normalize_audio(wav, NORMALIZE_DB)
    data = encode(wav, sample_rate, req["response_format"])
    logger.info(
        "track: draft={} duration={:.0f}s format={} seed={} peak={:.3f} rms={:.3f} took {:.1f}s",
        req["draft"], req["duration"], req["response_format"], seed, peak, wav.pow(2).mean().sqrt().item(),
        time.monotonic() - started,
    )
    return data


def load() -> None:
    """Loads both DiTs with the VAE and text encoder; any failure ends the process so systemd and llama-swap see it."""
    try:
        if not torch.cuda.is_available():
            raise RuntimeError("no ROCm GPU visible to torch")
        checkpoints = get_checkpoints_dir()
        # ACE-Step downloads missing weights on its own; a server must not start a 20 GB download, so check first.
        missing = [] if check_main_model_exists(checkpoints) else ["main bundle"]
        missing += [d["config_path"] for d in DITS.values() if not check_model_exists(d["config_path"], checkpoints)]
        if missing:
            raise RuntimeError(f"weights missing in {checkpoints}: {', '.join(missing)}")
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(acestep.__file__)))
        for draft, dit in DITS.items():
            handler = AceStepHandler()
            message, ok = handler.initialize_service(
                project_root=project_root, config_path=dit["config_path"], device="cuda",
                use_flash_attention=False, compile_model=False, offload_to_cpu=False, offload_dit_to_cpu=False,
            )
            if not ok:
                raise RuntimeError(message)
            if handler.is_turbo_model() != draft:
                raise RuntimeError(f"{dit['config_path']}: turbo={handler.is_turbo_model()}, expected {draft}")
            handlers[draft] = handler
        state["status"] = "ready"
        logger.info("ready: {} and {} loaded", DITS[False]["config_path"], DITS[True]["config_path"])
    except BaseException:
        logger.exception("loading failed")
        os._exit(1)


app = FastAPI(title="ACE-Step 1.5 XL", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict:
    return {"status": state["status"]}


@app.get("/ready")
def ready() -> JSONResponse:
    return JSONResponse({"status": state["status"]}, status_code=200 if state["status"] == "ready" else 503)


@app.post("/v1/audio/music")
async def music(request: Request) -> Response:
    try:
        req = parse(await request.json())
    except BadRequest as exc:
        return error(400, str(exc), "invalid_request_error")
    except ValueError:
        return error(400, "the body is not valid JSON", "invalid_request_error")
    if state["status"] != "ready":
        return error(503, "the model is still loading", "server_error")
    try:
        # generate runs in a worker thread, and asks the event loop whether the client is still there.
        data = await run_in_threadpool(generate, req, lambda: from_thread.run(request.is_disconnected))
    except Gone:
        logger.info("the client hung up; its track is not made")
        return Response(status_code=499)  # nobody reads it: the access log shows why no track was sent
    except Exception as exc:
        logger.exception("generation failed")
        return error(500, f"generation failed: {exc}", "server_error")
    return Response(data, media_type=FORMATS[req["response_format"]])


if __name__ == "__main__":
    # ACE-Step logs the text encoder's whole input (prompt and lyrics) at INFO: keep people's words out of the journal.
    logger.remove()
    logger.add(sys.stderr, level="INFO", filter=lambda r: r["level"].no >= 30
               or r["name"] != "acestep.core.generation.handler.conditioning_text")
    threading.Thread(target=load, name="load", daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
