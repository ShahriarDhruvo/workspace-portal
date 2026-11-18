# LLM server

What the reference LLM server runs besides portal-hostd ([hostd/README.md](../hostd/README.md)). The portal needs
none of it: any OpenAI-compatible model server will do. The measurements behind these choices are in
[docs/MEASUREMENTS.md](../docs/MEASUREMENTS.md).

| File | What it is |
|---|---|
| `gufo.container` | Podman quadlet of the Gufo engine: Qwen3.8-Flash-Next with seven sessions of 131,072 tokens, MTP and vision, on port 8080. It goes to `~/.config/containers/systemd/`. On an engine update portal-hostd rewrites the `Image=` and `Documentation=` lines of that copy. |
| `download-model.sh` | Fetches the six model files (115 GB) to `/models/qwen3.8-flash-next` and checks each SHA256. Run it again after an interruption. |
| `acceptance.py` | Full-load test: fills every session at once, has each find three keys and make a tool round trip, and watches memory. Prints `FUNCTIONAL` and `CAPACITY`, `PASS` or `FAIL`. About ten minutes with the whole server. |
| `fans/` | Fan curve and power profile for one machine, the Bosgame M5 (board AXB35-02, BIOS 3.11). |

## Fans

```sh
sudo bash llm-server/fans/install.sh              # refuses any other board or BIOS, and Secure Boot
sudo bash llm-server/fans/install.sh uninstall    # the firmware controls the fans again
python3 -m unittest llm-server/fans/test_fans.py
```

The installer fetches [cmetz/ec-su_axb35-linux](https://github.com/cmetz/ec-su_axb35-linux) at a pinned commit,
applies `ec_su_axb35-m5duty3.patch` and builds the module with DKMS, which rebuilds it for new kernels. The patch
adds a duty file per fan: the module checks every write, accepts 40 to 95 percent, and hands a fan back to the
firmware when no duty arrives for 10 seconds. It loads on the tested board and BIOS only.

`m5-fans.service` runs `m5-fans.py`, which sets both main fans every 2 seconds from the hotter of CPU and GPU:

| Temperature | Duty |
|---|---|
| below 60 °C | firmware control; handed back once under 55 °C |
| 60 to 84 °C | 40%, rising in 5% steps to 75% |
| 85 to 89 °C | 80% |
| 90 °C and above | 95%, until back under 87 °C |
| a sensor cannot be read | 95% |

`m5-power.service` selects the firmware's `performance` profile at boot; `balanced` and `quiet` are the others.

The patch changes a GPL driver and is under that driver's licence. The rest of this folder is Apache-2.0.
