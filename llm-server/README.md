# AI server

What the reference AI server runs besides portal-hostd ([hostd/README.md](../hostd/README.md)). The portal needs
none of it: any OpenAI-compatible model server will do. [docs/GUIDE.md](../docs/GUIDE.md) installs it step by
step; the measurements behind these choices are in [docs/MEASUREMENTS.md](../docs/MEASUREMENTS.md).

| File | What it is |
|---|---|
| `llama-swap.yaml` | [llama-swap](https://github.com/mostlygeek/llama-swap) v277's configuration, to `~/.config/llama-swap/config.yaml`: one address, port 8080, for the LLM, the two image models and the media models, which do not fit in memory together. A request names its model; llama-swap starts that model's unit and, for a model of an exclusive group (`llm`, `images`, `media`), first stops the other groups' models, once their requests have finished. Both image models may run at once, the media models one at a time. The everyday speech and transcription models (group `speech`) start beside whatever runs, the LLM included, one at a time. The LLM starts with llama-swap. LTX-2.5's entry is commented out until its weights are in ([docs/GUIDE.md](../docs/GUIDE.md#ltx-25)). Its own routes (`/api`, `/ui`, `/logs`, `/running`, `/upstream`) are the admin's: the portal passes none of them on to workspaces or API keys. The gateway itself reaches video and music at `/upstream/<model>/` (`MEDIA_MODEL_PATH`), as llama-swap routes neither, and the LLM's `/slots` the same way. |
| `llama-swap.service` | The systemd user unit that runs llama-swap at boot, to `~/.config/systemd/user/`: the release `~/.local/lib/llama-swap/current` points at. It listens on every interface without a login: open port 8080 in the firewall to the portal server alone. |
| `apps.json`, `apps/` | The programs besides Gufo that **Admin > Updates** updates through portal-hostd (llama-swap, vLLM, the media programs), and each one's `install.sh VERSION DEST`, which builds a version beside the others. portal-hostd's installer copies them; [hostd/README.md](../hostd/README.md#other-software) describes the keys. llama-swap's downloads a release and checks it against the checksums GitHub publishes with it. fish-speech's, ACE-Step's and LTX-2's each build the upstream tag's checkout with a Python environment of its own (uv, Python 3.12, PyTorch for ROCm with gfx1151's kernels) and copy in the portal's server for it: `fish-speech-openai.py` (OpenAI's `/v1/audio/speech`, WAV only), `acestep-sync.py` (the portal's `/v1/audio/music`, one track per request, both XL models in one process) and `ltx-videos.py` (Gufo's video job API, one job at a time). `apps/ltx/test_ltx_videos.py` tests that last one without a GPU, weights or LTX-2: `python3 -m unittest llm-server/apps/ltx/test_ltx_videos.py`. |
| `gufo.container` | Podman quadlet of the LLM: Gufo serving Qwen3.8-Flash-Next with four sessions of 262,144 tokens, replies of 64,000 tokens of which thinking takes at most 32,000, MTP and vision, and a 32 GiB disk tier of the prompt cache in `/models/gufo-cache`, on 127.0.0.1:18080. llama-swap starts and stops it; it has no `[Install]` and does not restart itself. It goes to `~/.config/containers/systemd/`. The engine runs confined by SELinux, which needs `sudo setsebool -P container_use_devices 1` for the GPU. On an engine update portal-hostd rewrites the `Image=` and `Documentation=` lines of this file and of every quadlet beside it with Gufo's image: the image and media models' below. |
| `gufo-image-turbo.container`, `gufo-image.container` | Quadlets of Qwen-Image-2.1-Turbo (eight steps) and Qwen-Image-2.1 on 127.0.0.1:18082 and 18081, from `/models/gufo-models`, where `gufo model install` puts them. They load their weights with the first request, and are under the non-commercial Qwen Research License. |
| `gufo-video.container` | Quadlet of MiniMax H3, video with stereo sound from text or keyframes through Gufo's video job API, on 127.0.0.1:18083, from `/models/gufo-models` (`gufo model install minimax-h3`). Its jobs and their MP4s go to `/models/gufo-cache/video-jobs`, kept an hour after they end (`--ttl 3600`). It starts once 90 GiB of GPU memory are free. Under the MiniMax H3 Community License, which grants nothing in the United States, the European Union, the United Kingdom or South Korea ([docs/GUIDE.md](../docs/GUIDE.md#media-models)). |
| `gufo-tts.container`, `gufo-tts-clone.container`, `gufo-tts-design.container` | Quadlets of Qwen3-TTS 1.7B on 127.0.0.1:18087 to 18089, beside the LLM: CustomVoice (nine built-in voices, with style instructions), Base (a voice cloned from a WAV of up to 30 s) and VoiceDesign (a voice described in words). Gufo's catalog has only Base (`gufo model install qwen3-tts`); the other two are `hf download`s at fixed revisions into the same folder. Their 8,192-token context holds Gufo's longest input with 240 s of speech. Each starts once 10 GiB are free: 7 GiB loaded, about 10 GiB after a WAV of 24 s or more. |
| `gufo-asr.container` | Quadlet of Qwen3-ASR 1.7B on 127.0.0.1:18090, beside the LLM: text from recordings of up to 30 minutes and 64 MB, cut at quiet points into pieces of its 1,024-token context (about 50 s). Longer pieces read worse: 4,096 gave 68% word errors on a 5-minute recording, 1,024 gave 1%. It starts once 6 GiB are free. |
| `vllm-sov.container` | Quadlet of SOV-Transcribe-1 with its DFlash draft model, text only (vLLM 0.32.0 answers 400 to `srt`, `vtt` and `verbose_json`), on 127.0.0.1:18085: [kyuz0's vLLM 0.32.0 image](https://github.com/kyuz0/amd-strix-halo-vllm-toolboxes) for gfx1151, pinned by digest and never pulled by the unit (`podman pull` it first). The model's vLLM plugin and three audio decoders come from `/opt/ai-studio/vllm-sov/site-packages`; the command that puts them there is in the file. It takes recordings of up to 30 minutes and 64 MB. Its KV cache is capped at 36 GiB, 270,865 tokens, which holds eight 32K requests: without the cap vLLM filled 105.8 GiB and left a speech model no room, with it the file gives a peak of 89.4 GiB. TunableOp is off: with it the engine took 1,120 s to start instead of 17 s. It starts once 90 GiB are free. **Admin > Updates** updates its image. |
| `media/` | The media programs that are no containers, as systemd user units to `~/.config/systemd/user/`: `fish-speech.service` (Fish Audio S2-Pro on 127.0.0.1:18084), `acestep.service` (ACE-Step 1.5 XL base and turbo on 18086) and `ltx.service` (LTX-2.5 22B distilled on 18091). Each runs the version `/opt/ai-studio/<program>/current` points at and starts once the GPU memory it needs is free. They unset TunableOp, which tunes every new shape: a new 26 s text took Fish S2-Pro 184 s with it, 58 s without. `cache.env` goes to `/etc/ai-studio/` and names the cache folders in `/var/cache/ai-studio`, which these units and `vllm-sov.container` read, so a swap or a reboot compiles and downloads nothing again; `ai-studio-cache.sh` goes to `/etc/profile.d/` and gives login shells the same. |
| `media.json` | The image and media models of this server for the portal, by kind and tier (fast and quality), with every field explained. On the portal server: `sudo bash deploy/models.sh install llm-server/media.json`. A fresh install has `models/media.json`, which names none. |
| `wait-gpu-memory` | Run by each model's unit before it starts, from `~/.local/bin/`: waits up to 60 seconds until the GPU memory it needs is free (amdgpu's GTT counters), as the model llama-swap just stopped may still hold it. |
| `acceptance.py` | Full-load test, against Gufo on port 18080: fills every session at once, has each find three keys and make a tool round trip, and watches memory. Prints `FUNCTIONAL` and `CAPACITY`, `PASS` or `FAIL`. About 19 minutes with the whole server. |
| `fans/` | Fan curve and power profile for one machine, the Bosgame M5 (board AXB35-02, BIOS 3.11). |
| `apu-tuning.service` | At every boot, with RyzenAdj: a curve offset of -25 on every CPU core, and the power and temperature limits at the firmware's maximum (132 W sustained, 140 W slow, 160 W peak, 98 °C). It runs after the fan service has selected the Performance profile, as selecting a profile resets the limits. It goes to `/etc/systemd/system/`. -50 froze the test machine five times ([Freezes](../docs/MEASUREMENTS.md#freezes)). |
| `watchdog.conf` | Has systemd keep the chipset's watchdog (`sp5100_tco`) armed, so a hang of 30 seconds reboots the machine. It goes to `/etc/systemd/system.conf.d/`. |

## Fans

```sh
sudo bash llm-server/fans/install.sh              # refuses any other board or BIOS, and Secure Boot
sudo bash llm-server/fans/install.sh uninstall    # the firmware controls the fans again
python3 -m unittest llm-server/fans/test_fans.py
```

`ec_su_axb35.c` is the kernel module for the board's embedded controller, built by DKMS, which rebuilds it for
new kernels. It loads on the tested board and BIOS only and shows, under `/sys/class/ec_su_axb35`, the three
fan speeds, the EC's temperature, the firmware's power profile (`balanced`, `performance`, `quiet`) and a duty
for each of the two main fans. A duty is checked (40 to 99 percent, written and read back) and is a lease: the
fan goes back to the firmware when no duty arrives for 10 seconds.

`m5-fans.service` loads the module, selects `performance` and runs `m5-fans.py`, which sets both main fans
every 2 seconds from the hotter of CPU and GPU:

| Temperature | Duty |
|---|---|
| below 60 °C | firmware control; handed back once under 55 °C |
| 60 to 69 °C | 50%, 5% more for each degree, up to 95% |
| 70 °C and above | 99%, both fans' top speed, until back under 67 °C |
| a sensor cannot be read | 99% |

The module refuses 100%: there both fans hold their top speed for about 25 seconds, then fall to 1,300-2,600 rpm
and keep cycling ([Fans](../docs/MEASUREMENTS.md#fans)). The third fan has no duty register and stays with the
firmware.

The module is reduced from [cmetz/ec-su_axb35-linux](https://github.com/cmetz/ec-su_axb35-linux) and stays under
that driver's licence, GPL-2.0-only (`fans/COPYING`). The rest of this folder is GPL-2.0-or-later.
