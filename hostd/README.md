# portal-hostd

One daemon per server, for the portal's gateway. It needs only `python3` (standard library) and systemd.

- Both roles: live hardware readings (CPU, GPU, memory, memory bandwidth, power, fans, network, disks) and running totals of energy and network bytes.
- `llm` role only: updates the engine container, a rootless Podman quadlet, when the gateway asks.

While nobody watches, nothing is sampled: only the meter wakes, every 2 s, to read the power source and `/proc/net/dev`.

## Install, update, uninstall

Run from a checkout of this repo. To update, run the same command again from the new checkout.

```sh
# portal server: listens on 127.0.0.1
sudo bash hostd/install.sh portal --token-stdin --port 9180 <<<"$token"

# LLM server: listens on 0.0.0.0, firewalld lets only the portal server in
sudo bash hostd/install.sh llm --portal <portal IPv4>
sudo bash hostd/install.sh llm --portal <portal IPv4> --engine-unit none    # readings only

sudo bash hostd/install.sh uninstall
```

| Option | Meaning |
|---|---|
| `--token-stdin` | Read the bearer token as one line from stdin: at least 32 characters, no whitespace inside. Without it the token in `/etc/portal-hostd/token` is kept, or a new one is generated |
| `--port N` | Listen port, default 9180 |
| `--portal IPv4` | `llm` only, required: the one address the firewall lets in |
| `--engine-unit UNIT` | `llm` only: the engine's systemd user unit, or `none`. Default: `gufo.service` if the engine user has `~/.config/containers/systemd/gufo.container`, else none |
| `--engine-user USER` | `llm` only: the user who owns the quadlet. Default: `$SUDO_USER` |

What the installer does:

- Writes `/etc/portal-hostd/hostd.conf` and `/etc/portal-hostd/token` (0600), installs the daemon to `/usr/local/lib/portal-hostd/` and the unit `portal-hostd.service`, enables it, and tries `GET /v1/health` up to 20 times, half a second apart.
- Restarts the service only if the daemon, the unit, the conf or the token changed, or if it is not running.
- `llm`: adds the permanent firewalld rich rule `rule family="ipv4" source address="<portal>/32" port port="<port>" protocol="tcp" accept` to the zone of the interface that routes to the portal, and removes the rule of an earlier address or port. Without a running firewalld it only warns.
- `llm`: ends by printing `HOSTD_LLM_URL=...` and `HOSTD_LLM_TOKEN=...` for the portal's `.env`. A token that came in on stdin is not printed.
- `uninstall` removes the unit, `/etc/portal-hostd`, `/usr/local/lib/portal-hostd` and the firewalld rule. It keeps the engine user's `~/.local/state/portal-hostd`.

Engine control needs, for the engine user:

- the quadlet `~/.config/containers/systemd/<unit name>.container`, with exactly one `Image=` line;
- linger (`sudo loginctl enable-linger USER`), so that the user's systemd manager runs without a login.

The installer creates `~/.local/state/portal-hostd` (0700) for that user; the quadlet as it was before the last update is saved there.

## Configuration

`/etc/portal-hostd/hostd.conf` is a systemd EnvironmentFile and holds no secret. After editing it: `sudo systemctl restart portal-hostd`. A re-run of the installer keeps `INTERVAL_MS` and `ENGINE_URL` and rewrites the rest.

| Key | Meaning |
|---|---|
| `ROLE` | `portal` or `llm` |
| `BIND`, `PORT` | Listen address and port |
| `INTERVAL_MS` | Time between samples, 250..5000, default 500 |
| `ENGINE_UNIT`, `ENGINE_QUADLET` | `llm` with engine control: the user unit and its quadlet file |
| `ENGINE_URL` | The engine's own HTTP address, default `http://127.0.0.1:8080`: `/ready` and `/props` are asked there |
| `FIREWALL_SOURCE` | The `--portal` address, kept so that the installer can find its firewalld rule again |

Logs: `journalctl -u portal-hostd`.

## What it reads

The files a sample reads are opened once, kept open and read with `pread`; no sample starts a process. Not kept open: the sampler's perf counters, closed 30 s after the last viewer, and `/proc/self/mounts`, read again for each measurement of disk space. An interface or disk seen for the first time is looked up in sysfs.

| Reading | AMD APU (amdgpu) | Intel (i915) |
|---|---|---|
| CPU usage, per logical CPU too | `/proc/stat` | same |
| CPU clock | `cpufreq/scaling_cur_freq` of the CPUs more than 1% busy, weighted by their usage | same |
| CPU temperature | hwmon `k10temp` | hwmon `coretemp`, the package |
| GPU usage, clock, temperature, power | `gpu_metrics` (format 3.0) | usage from the i915 PMU `rcs0-busy`, else the time not in RC6; clock from `gt_act_freq_mhz`; the CPU package's temperature; RAPL's GPU share as power |
| GPU memory | `mem_info_vram_used`, `mem_info_vram_total` | none |
| Power | `gpu_metrics` socket power, with the cores' and the GPU's shares | RAPL perf PMU: package + DRAM, with the cores' and the GPU's shares |
| Memory | `/proc/meminfo`; `gpuBytes` is its `GPUActive` | `/proc/meminfo` |
| Memory bandwidth | `amd_df` perf PMU: DRAM read and write beats | `uncore_imc` perf PMU: data reads and writes |
| Fans | `/sys/class/ec_su_axb35/fanN/rpm` and `duty`, every 3 s in a thread of their own (an EC read is slow) | none |
| Network | `/proc/net/dev` bytes of the interfaces with hardware behind them (`/sys/class/net/IF/device`): not lo, bridges, veth or tunnels | same |
| Disk I/O | `/proc/diskstats` sectors of the whole disks (`/sys/block/DEV/device`): no partitions, loop, zram, dm or md | same |
| Disk space | `statvfs` of the filesystems on local block devices in `/proc/self/mounts`, one per device, at most every 5 s in a thread of its own | same |
| Energy total | the socket power integrated at every meter tick | a RAPL perf group of the meter's own: package + DRAM |

A source that is missing gives `null` in the sample; `sources` in `/v1/info` names the ones in use.

## Privileges

- `portal` role, and `llm` without engine control: `DynamicUser=yes`, `ProtectHome=yes`.
- `llm` with engine control: runs as the engine user, with `ProtectHome=read-only` and write access to the quadlet directory and `~/.local/state/portal-hostd` only.
- The only capability is `CAP_PERFMON`, for the perf PMUs. Without it there is no memory bandwidth, no Intel power and energy, and Intel GPU usage comes from RC6.
- The unit also sets `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictNamespaces`, `LockPersonality`, `MemoryDenyWriteExecute`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `MemoryMax=64M`, `CPUQuota=20%`, `TasksMax=32`, `Nice=10`.
- Engine commands run in the engine user's systemd manager, not in this service: `systemctl --user ...` and `systemd-run --user --wait --pipe --quiet --collect podman ...`. Under `NoNewPrivileges` the service could not run rootless podman itself.

## API

HTTP/1.1. Every request but `GET /v1/health` needs `Authorization: Bearer <token>`. Errors are `{"error": "<code>", "message": "..."}`, except what Python's `http.server` refuses itself, which gets its HTML error page: a method other than GET, POST and DELETE (501) and a malformed request (400, 414, 431, 505).

| Method and path | Answer |
|---|---|
| `GET /v1/health` | `{"ok": true}`, no token needed |
| `GET /v1/info` | `hostname`, `role`, `os`, `kernel`, `intervalMs`, `cpu`, `gpu`, `memory`, `sources`, `power`, `engine`, and what `net` and `disk` count right now: `network.interfaces`, `disks.devices`, `disks.mounts` |
| `GET /v1/sample` | One sample: `t`, `cpu`, `gpu`, `memory`, `power`, `fans`, `throttling`, `net`, `disk`. Rates are `null` in the first sample after idle. Keeps the sampler running for 5 s |
| `GET /v1/stream` | Server-sent events: `event: info` once, then `event: sample` every `INTERVAL_MS`, and `: ping` after 15 s without one. At most 4 streams. A slow reader gets the newest sample, not every one |
| `GET /v1/meter` | `instance`, `startedAt`, `t`, `energyJ`, `rxBytes`, `txBytes`: totals since this daemon started, as of its last tick (`t`). `instance` is random per start. `energyJ` is `null` without a power source, the bytes without a physical interface |
| `GET /v1/engine` | Unit state, `ready`, `buildInfo`, the quadlet's image, the previous one, the local images of its repository (the listing is cached for 5 s) and the last job |
| `POST /v1/engine/pull` `{"image": "<repository>@sha256:<64 hex>"}` | 202 and the job. The repository must be the quadlet's |
| `POST /v1/engine/apply` `{"image": ..., "version": "X.Y.Z" or null}` | 202 and the job. The image must have been pulled |
| `POST /v1/engine/cancel` | `{"cancelled": true or false}`: only a running pull can be cancelled |
| `DELETE /v1/engine/images/sha256:<64 hex>` | `{"ok": true}` |

| Status | Codes |
|---|---|
| 400 | `bad_request` (Content-Length), `invalid_json`, `invalid_image`, `wrong_repository`, `invalid_version` |
| 401 | `unauthorized` |
| 404 | `not_found` (no such endpoint, or no such local image), `no_engine` (no engine control on this host) |
| 405 | `method_not_allowed` |
| 409 | `job_running`, `not_pulled`, `image_current`, `rmi_failed` |
| 411 | `length_required` (chunked bodies are refused) |
| 413 | `body_too_large` (over 4096 bytes) |
| 429 | `too_many_streams` |
| 500 | `quadlet_invalid` (unreadable, or not exactly one `Image=` line), `internal` |
| 503 | `too_many_connections` (over 16), `no_sample`, `podman_failed` |

A request whose line, headers and body take more than 10 s is dropped.

An apply, which is also how to go back to an older image, runs these steps; each becomes the job's `step`:

1. Check that the image is local.
2. Save the quadlet as `~/.local/state/portal-hostd/<unit name>.container.prev`.
3. Rewrite the quadlet: only the `Image=` value changes and, with a version, the `/vX.Y.Z/` part of `Documentation=`.
4. `systemctl --user daemon-reload` and `restart`.
5. Wait up to 10 minutes for the engine's `/ready` to answer 200.
6. With a version: check that `build_info` in the engine's `/props` starts with it.

If step 3 or a later one fails, the old quadlet is written back and the unit restarted; the job ends `failed`, with `rolledBack: true` once the old engine answers `/ready` again. If that fails too, `rolledBack` stays `false` and `error` names both failures.

## Run it locally

```sh
ROLE=llm python3 hostd/portal-hostd.py --print-info --print-sample    # JSON once, no server
ROLE=llm HOSTD_TOKEN_FILE=./token python3 hostd/portal-hostd.py       # serve; the token file holds at least 32 characters
python3 -m unittest hostd/test_hostd.py                               # from the repo root; no root, no network
```

`HOSTD_ROOT=/path` reads `/proc` and `/sys` from a tree under that path, as the tests do.
