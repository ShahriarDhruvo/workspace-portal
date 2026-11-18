# LLM server

What the reference LLM server runs besides portal-hostd ([hostd/README.md](../hostd/README.md)). The portal needs
none of it: any OpenAI-compatible model server will do. The measurements behind these choices are in
[docs/MEASUREMENTS.md](../docs/MEASUREMENTS.md).

| File | What it is |
|---|---|
| `gufo.container` | Podman quadlet of the Gufo engine: Qwen3.8-Flash-Next with four sessions of 262,144 tokens, replies of 64,000 tokens of which thinking takes at most 32,000, MTP and vision, on port 8080, without a login: open that port in the firewall to the portal server alone. It goes to `~/.config/containers/systemd/`. The engine runs confined by SELinux, which needs `sudo setsebool -P container_use_devices 1` for the GPU. On an engine update portal-hostd rewrites the `Image=` and `Documentation=` lines of the installed copy. |
| `download-model.sh` | Fetches the six model files (115 GB) to `/models/qwen3.8-flash-next` and checks each SHA256. Run it again after an interruption. |
| `acceptance.py` | Full-load test: fills every session at once, has each find three keys and make a tool round trip, and watches memory. Prints `FUNCTIONAL` and `CAPACITY`, `PASS` or `FAIL`. About eleven minutes with the whole server. |
| `fans/` | Fan curve and power profile for one machine, the Bosgame M5 (board AXB35-02, BIOS 3.11). |
| `undervolt.service` | Sets the CPU's curve offset to -50 at every boot with RyzenAdj, which must be installed. It goes to `/etc/systemd/system/`. Check the offset on your chip first: [CPU undervolt](../docs/MEASUREMENTS.md#cpu-undervolt). |

## Fans

```sh
sudo bash llm-server/fans/install.sh              # refuses any other board or BIOS, and Secure Boot
sudo bash llm-server/fans/install.sh uninstall    # the firmware controls the fans again
python3 -m unittest llm-server/fans/test_fans.py
```

`ec_su_axb35.c` is the kernel module for the board's embedded controller, built by DKMS, which rebuilds it for
new kernels. It loads on the tested board and BIOS only and shows, under `/sys/class/ec_su_axb35`, the three
fan speeds, the EC's temperature, the firmware's power profile (`balanced`, `performance`, `quiet`) and a duty
for each of the two main fans. A duty is checked (40 to 95 percent, written and read back) and is a lease: the
fan goes back to the firmware when no duty arrives for 10 seconds.

`m5-fans.service` loads the module, selects `performance` and runs `m5-fans.py`, which sets both main fans
every 2 seconds from the hotter of CPU and GPU:

| Temperature | Duty |
|---|---|
| below 60 °C | firmware control; handed back once under 55 °C |
| 60 to 84 °C | 40%, rising in 5% steps to 75% |
| 85 to 89 °C | 80% |
| 90 °C and above | 95%, until back under 87 °C |
| a sensor cannot be read | 95% |

The module is reduced from [cmetz/ec-su_axb35-linux](https://github.com/cmetz/ec-su_axb35-linux) and stays under
that driver's licence, GPL-2.0 (`fans/COPYING`). The rest of this folder is Apache-2.0.
