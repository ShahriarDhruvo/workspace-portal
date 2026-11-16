# portal-hostd

A small per-server daemon written for the portal's gateway, using only the Python 3.11+ standard library. It has two jobs:

1. Serve live hardware readings: CPU, GPU, memory, memory bandwidth, power and fans (both roles).
2. On the LLM server only, update the engine container (the gufo rootless Podman quadlet) when the gateway asks.

When nobody is watching it does no sampling and uses no CPU. With a stream open at 2 Hz it uses about 1 ms of CPU per sample.

| File | What it is |
|---|---|
| `portal-hostd.py` | The daemon. Installed to `/usr/local/lib/portal-hostd/` |
| `portal-hostd.service` | Unit template. `install.sh` fills in the `@PLACEHOLDERS@` |
| `install.sh` | Installer for both roles and for uninstall |
| `test_hostd.py` | `python3 -m unittest hostd/test_hostd.py` from the repo root. Needs no root and no network |

## Install, update, uninstall

```sh
# portal server (locust): binds 127.0.0.1
sudo bash hostd/install.sh portal --token-stdin --port 9180 <<<"$token"

# LLM server (thephilosopher): binds 0.0.0.0, firewalld lets only the portal in
sudo bash hostd/install.sh llm --portal 192.168.10.11            # engine user = $SUDO_USER, engine = gufo.service if its quadlet exists
sudo bash hostd/install.sh llm --portal 192.168.10.11 --engine-unit none   # readings only

sudo bash hostd/install.sh uninstall
```

- **Token.** `--token-stdin` reads the token as one line from stdin. It is trimmed, and refused if it is under 32 characters or has whitespace inside. Never pass a secret as an argument: `/proc/*/cmdline` is world-readable. Without `--token-stdin`, an existing `/etc/portal-hostd/token` is kept, otherwise a new one is generated with `openssl rand -hex 32`.
- **Other options.**
  - `--port` (default 9180)
  - `--engine-user USER`
  - `--engine-unit gufo.service|none`
  - `--name NAME`: display hostname override, used when the static hostname is unset, as on locust ("localhost")
- **Re-running is safe.** It restarts the service only when the daemon, unit, conf or token changed, or when the service is not running. `INTERVAL_MS`, `ENGINE_URL` and `HOSTD_NAME` survive a reinstall.
- **LLM role output.** The installer ends by printing the lines for the portal's `.env`:
  - `HOSTD_LLM_URL=http://<this host's IPv4 on the route to the portal>:<port>`
  - `HOSTD_LLM_TOKEN=...`. The token itself is printed only when the installer generated or kept it. A token passed on stdin is not echoed.
- **LLM role checks.**
  - Linger must be on for the engine user.
  - The installer creates `~<user>/.local/state/portal-hostd` (0700), where the saved previous quadlet lives.
  - It adds the firewalld rich rule `source address="<portal>/32" port <port>/tcp accept`, permanent, in the zone of the interface that routes to the portal.
- **Health check.** The installer waits up to 10 s for `GET /v1/health` and fails loudly otherwise.
- **Uninstall.** Removes the unit, `/etc/portal-hostd` (conf and token), `/usr/local/lib/portal-hostd` and the firewalld rule. It keeps the engine user's state dir.

Config is `/etc/portal-hostd/hostd.conf`, a systemd EnvironmentFile and not secret:

| Key | Meaning |
|---|---|
| `ROLE` | `portal` or `llm` |
| `BIND`, `PORT` | Listen address and port |
| `INTERVAL_MS` | 250..5000, default 500 |
| `HOSTD_NAME` | Optional display name |
| `ENGINE_UNIT`, `ENGINE_QUADLET`, `ENGINE_URL` | LLM role with engine control |
| `FIREWALL_SOURCE` | Written by the installer so `uninstall` can find the rule |

After editing the conf, run `sudo systemctl restart portal-hostd`.

## What it reads

All sources are opened once and kept open, then read with `pread`. There is no subprocess per sample.

| Reading | Strix Halo (amdgpu) | Intel client (i915) |
|---|---|---|
| CPU usage, per-core usage | `/proc/stat` | same |
| CPU clock | `cpufreq/scaling_cur_freq` (APERF/MPERF based). Only CPUs that were >1% busy count; the average is busy-weighted. amd-pstate's idle fallback value is ignored | same |
| CPU temperature | k10temp Tctl | coretemp "Package id 0" |
| GPU busy, clock, temperature, power | `gpu_metrics` v3.0 (264 bytes): gfx activity, gfxclk, gfx temperature, gfx power | busy from the i915 PMU `rcs0-busy` (needs CAP_PERFMON), else 100 − rc6 residency. Clock from `gt_act_freq_mhz`. Temperature = package temperature |
| Power | `gpu_metrics` socket power (APU), with core/gfx parts | RAPL perf PMU: package + DRAM, with cores/gpu parts |
| Memory | `/proc/meminfo`. `gpuBytes` = `GPUActive` (GTT+VRAM in use by the GPU) | `/proc/meminfo`. `gpuBytes` null |
| GPU memory | `mem_info_vram_used/total` (the BIOS carve-out) | null |
| Memory bandwidth | `amd_df` perf PMU: DRAM channels 0/4/8/12, read and write beats × 256 B (needs CAP_PERFMON) | `uncore_imc` data_reads/data_writes × 64 B (needs CAP_PERFMON) |
| Fans | `ec_su_axb35` EC driver: `/sys/class/ec_su_axb35/fanN/rpm` (+ `duty`), read every 3 s by a separate thread (each read is a slow EC transaction) | none on this host |

Bandwidth and power were checked against a known 2 GiB single-thread memmove and against powercap/hwmon. The agreement was:

- bandwidth: within 2 to 9%
- power: within 0.01 W
- temperatures: within 0.1 °C
- CPU usage: within 0.05 points

## Privileges and hardening

- **Identity.**
  - Portal role: `DynamicUser=yes` and `ProtectHome=yes`.
  - LLM role with an engine: `User=<engine user>`, with `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` set to the user's manager, `ProtectHome=read-only`, and `ReadWritePaths=` for the quadlet dir and `~/.local/state/portal-hostd`.
  - The only capability is `CAP_PERFMON`, ambient and bounding, because `perf_event_paranoid` is 2. Without it the daemon still runs but reports `bandwidth: null`, Intel `power: null` and Intel GPU busy from rc6.
- **Hardening.** The daemon also runs under all of these: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictNamespaces`, `LockPersonality`, `MemoryDenyWriteExecute`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `MemoryMax=64M`, `CPUQuota=20%`, `TasksMax=32`, `Nice=10`.
- **None of the hardening lines had to be dropped.** Every line was tested on both hosts in 2026-11, with identical properties, with readings and engine control working:
  - Fedora 44, Strix Halo: llm role, `User=`
  - Fedora 45, Pentium G4400T: portal role, `DynamicUser`

  In particular, ctypes `syscall(perf_event_open)` works under `MemoryDenyWriteExecute`, and `systemd-run --user` reaches the user manager through the read-only `/run/user/<uid>`.
- **Engine commands.** Every podman and systemctl call for the engine goes through the engine user's own systemd manager: `systemctl --user ...` and `systemd-run --user --wait --pipe --quiet --collect [--unit=portal-hostd-<job>] podman ...`. Under NoNewPrivileges the service cannot run rootless podman's newuidmap helpers itself, but processes started by the user manager are unconstrained.
- **Start command.** `ExecStart` loads the file as a module rather than running it as a script, which saves about 4.5 MB of RSS. The installer precompiles it.

## API

Every request needs `Authorization: Bearer <token>`, checked with `hmac.compare_digest`. `GET /v1/health` is the exception and answers `{"ok": true}`. Errors look like `{"error": "<code>", "message": "..."}`.

- **Server limits.**
  - HTTP/1.1, at most 16 concurrent connections (503 `too_many_connections`)
  - headers must arrive within 10 s
  - bodies at most 4 KiB (413 `body_too_large`)

| Method and path | Result |
|---|---|
| `GET /v1/info` | HostInfo: hostname, role, os, kernel, intervalMs, cpu, gpu, memory, sources, power label, engine |
| `GET /v1/sample` | HostSample. The first call after idle has null rates. It keeps the sampler running for 5 s |
| `GET /v1/stream` | SSE: `event: info`, then an `event: sample` every INTERVAL_MS. At most 4 streams (429 `too_many_streams`). A slow reader gets only the newest sample |
| `GET /v1/engine` | EngineStatus. The podman listing is cached for 5 s; state and ready are always fresh |
| `POST /v1/engine/pull` `{"image": "<repo>@sha256:<64 hex>"}` | 202 EngineJob |
| `POST /v1/engine/apply` `{"image": ..., "version": "X.Y.Z" or null}` | 202 EngineJob. The image must be local |
| `POST /v1/engine/rollback` | 202 EngineJob. Applies the saved previous quadlet's image and verifies `/ready` only |
| `POST /v1/engine/cancel` | `{"cancelled": bool}`. Only a running pull can be cancelled |
| `DELETE /v1/engine/images/sha256:<hex>` | `{"ok": true}` |

Engine error codes:

| Status | Codes |
|---|---|
| 404 | `no_engine` (no ENGINE_UNIT), `not_found` (DELETE of an unknown image) |
| 400 | `invalid_image`, `wrong_repository`, `invalid_version` |
| 409 | `not_pulled`, `no_previous` (also returned when the saved image is the current one), `job_running`, `image_current`, `rmi_failed` |
| 500 | `quadlet_invalid` |
| 503 | `podman_failed` |

**Apply steps.** These are the same for apply and rollback; each becomes the job's `step`, and the log lines are prefixed `HH:MM:SS`:

1. Check that the image is local.
2. Save the quadlet to `<state>/<stem>.container.prev`.
3. Rewrite the quadlet atomically. Only `Image=` changes, plus a `/vX.Y.Z/` segment in `Documentation=`.
4. `systemctl --user daemon-reload`, then `systemctl --user restart`.
5. Wait for `/ready` = 200 (10 min).
6. If a version was given, check that `/props` build_info starts with `"<version> "`.

If any step fails, the old quadlet is written back and restarted, and the job ends `failed` with `rolledBack: true`.

## Local runs

```sh
ROLE=llm HOSTD_TOKEN_FILE=./token python3 hostd/portal-hostd.py                 # serve (token file: >= 32 chars)
ROLE=llm python3 hostd/portal-hostd.py --print-info --print-sample               # one-shot JSON, no server
```

- `HOSTD_ROOT=/path` reads `/proc` and `/sys` from a fixture tree (used by the tests).
- `HOSTD_STATE_DIR` overrides `~/.local/state/portal-hostd`.
- Logs go to the journal: `journalctl -u portal-hostd`.
