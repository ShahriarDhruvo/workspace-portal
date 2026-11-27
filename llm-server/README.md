# LLM server

What the reference LLM server runs besides portal-hostd ([hostd/README.md](../hostd/README.md)). The portal needs
none of it: any OpenAI-compatible model server will do. [docs/GUIDE.md](../docs/GUIDE.md) installs it step by
step; the measurements behind these choices are in [docs/MEASUREMENTS.md](../docs/MEASUREMENTS.md).

| File | What it is |
|---|---|
| `llama-swap.yaml` | [llama-swap](https://github.com/mostlygeek/llama-swap) v276's configuration, to `~/.config/llama-swap/config.yaml`: one address, port 8080, for the LLM and the two image models, which do not fit in memory together. A request names its model; llama-swap starts that model's unit and first stops the other group's, once its requests have finished. Both image models may run at once. The LLM starts with llama-swap. Its own routes (`/api`, `/ui`, `/logs`, `/running`, `/upstream`) are the admin's: the portal passes none of them on. |
| `llama-swap.service` | The systemd user unit that runs llama-swap at boot, to `~/.config/systemd/user/`. It listens on every interface without a login: open port 8080 in the firewall to the portal server alone. |
| `gufo.container` | Podman quadlet of the LLM: Gufo serving Qwen3.8-Flash-Next with four sessions of 262,144 tokens, replies of 64,000 tokens of which thinking takes at most 32,000, MTP and vision, and a 32 GiB disk tier of the prompt cache in `/models/gufo-cache`, on 127.0.0.1:18080. llama-swap starts and stops it; it has no `[Install]` and does not restart itself. It goes to `~/.config/containers/systemd/`. The engine runs confined by SELinux, which needs `sudo setsebool -P container_use_devices 1` for the GPU. On an engine update portal-hostd rewrites the `Image=` and `Documentation=` lines of this file and of the two below. |
| `gufo-image-turbo.container`, `gufo-image.container` | Quadlets of Qwen-Image-2.1-Turbo (eight steps) and Qwen-Image-2.1 on 127.0.0.1:18082 and 18081, from `/models/gufo-models`, where `gufo model install` puts them. They load their weights with the first request, and are under the non-commercial Qwen Research License. |
| `wait-gpu-memory` | Run by each Gufo unit before it starts, from `~/.local/bin/`: waits up to 60 seconds until the GPU memory it needs is free (amdgpu's GTT counters), as the model llama-swap just stopped may still hold it. |
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
