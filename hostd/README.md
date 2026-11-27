# portal-hostd

One daemon per server, for the portal's gateway. It needs only `python3` (standard library) and systemd.

- Both roles: live hardware readings (CPU, GPU, memory, memory bandwidth, power, fans, network, disks) and running totals of energy and network bytes.
- `llm` role only: updates the engine container, a rootless Podman quadlet, and the [other software](#other-software)
  in `llm-server/apps.json` (llama-swap, vLLM, the media programs), when the gateway asks.

While nobody watches, nothing is sampled: only the meter wakes, every 2 s, to read the power source and `/proc/net/dev`.

## Install, update, uninstall

Run from a checkout of this repo. To update, run the same command again from the new checkout.

```sh
# portal server: listens on 127.0.0.1
sudo bash hostd/install.sh portal --token-stdin --port 9180 <<<"$token"

# AI server: listens on 0.0.0.0, firewalld lets only the portal server in
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
| `--engine-url URL` | `llm` only: the engine's own address (`ENGINE_URL`). Default: the conf's, else `http://127.0.0.1:8080` |
| `--engine-router URL MODEL` | `llm` only: the engine runs behind [llama-swap](../llm-server/README.md) at URL, as model MODEL; `none` removes it. Default: the conf's |
| `--apps on\|none` | `llm` with engine control only: update the [other software](#other-software) too, or not. Default: the conf's choice, else `on` |

What the installer does:

- Writes `/etc/portal-hostd/hostd.conf` and `/etc/portal-hostd/token` (0600), installs the daemon to `/usr/local/lib/portal-hostd/` and the unit `portal-hostd.service`, enables it, and tries `GET /v1/health` up to 20 times, half a second apart.
- Restarts the service only if the daemon, the unit, the conf, the token or `apps.json` changed, or if it is not running.
- `llm`: adds the permanent firewalld rich rule `rule family="ipv4" source address="<portal>/32" port port="<port>" protocol="tcp" accept` to the zone of the interface that routes to the portal, and removes the rule of an earlier address or port. Without a running firewalld it only warns.
- `llm`: ends by printing `HOSTD_LLM_URL=...` and `HOSTD_LLM_TOKEN=...` for the portal's `.env`. A token that came in on stdin is not printed.
- `llm` with `--apps on`: checks `llm-server/apps.json` as the daemon will, copies it and `llm-server/apps/` to `/usr/local/lib/portal-hostd/apps/`, and creates each dir program's root that is missing, owned by the engine user. A root that exists is left as it is; one owned by someone else gets a warning.
- `uninstall` removes the unit, `/etc/portal-hostd`, `/usr/local/lib/portal-hostd` and the firewalld rule. It keeps the engine user's `~/.local/state/portal-hostd` and the programs' installed versions.

Engine control needs, for the engine user:

- the quadlet `~/.config/containers/systemd/<unit name>.container`, with exactly one `Image=` line;
- linger (`sudo loginctl enable-linger USER`), so that the user's systemd manager runs without a login.

The installer creates `~/.local/state/portal-hostd` (0700) for that user; the quadlet as it was before the last update is saved there.

## Configuration

`/etc/portal-hostd/hostd.conf` is a systemd EnvironmentFile and holds no secret. After editing it: `sudo systemctl restart portal-hostd`. A re-run of the installer keeps `INTERVAL_MS`, `ENGINE_URL`, the `ENGINE_ROUTER_*` pair and whether `APPS_FILE` is set unless its options say otherwise, and rewrites the rest.

| Key | Meaning |
|---|---|
| `ROLE` | `portal` or `llm` |
| `BIND`, `PORT` | Listen address and port |
| `INTERVAL_MS` | Time between samples, 250..5000, default 500 |
| `ENGINE_UNIT`, `ENGINE_QUADLET` | `llm` with engine control: the user unit and its quadlet file |
| `ENGINE_URL` | The engine's own HTTP address, default `http://127.0.0.1:8080`: `/ready` and `/props` are asked there |
| `ENGINE_ROUTER_URL`, `ENGINE_ROUTER_MODEL` | Both or neither: llama-swap's address and the engine's model there. With them an apply restarts the engine through llama-swap, rewrites the image models' quadlets too, and `GET /v1/engine` says `unloaded: true` while llama-swap has the engine stopped |
| `APPS_FILE` | `llm` with engine control: the programs it updates, `/usr/local/lib/portal-hostd/apps/apps.json`; empty: none (`--apps none`). Each program's `install.sh` is in `<id>/` beside it |
| `FIREWALL_SOURCE` | The `--portal` address, kept so that the installer can find its firewalld rule again |

Logs: `journalctl -u portal-hostd`.

## What it reads

The files a sample reads are opened once, kept open and read with `pread`; no sample starts a process. Not kept open: the sampler's perf counters, closed 30 s after the last viewer, and `/proc/self/mounts`, read again for each measurement of disk space. An interface or disk seen for the first time is looked up in sysfs.

| Reading | AMD APU (amdgpu) | Intel (i915) |
|---|---|---|
| CPU usage, per logical CPU too | `/proc/stat` | same |
| CPU clock | `msr` perf PMU per CPU: TSC rate × aperf/mperf, each CPU's average clock while it ran (turbostat's busy MHz), of the CPUs more than 1% busy, weighted by the time each ran | same |
| CPU temperature | hwmon `k10temp` | hwmon `coretemp`, the package |
| GPU usage, clock, temperature, power | `gpu_metrics` (format 3.0) | usage from the i915 PMU `rcs0-busy`, else the time not in RC6; clock from `gt_act_freq_mhz`; the CPU package's temperature; RAPL's GPU share as power |
| GPU memory | `mem_info_vram_used`, `mem_info_vram_total` | none |
| Power | RAPL perf PMU: the package (CPU, GPU and the rest of the chip); the cores' share from the `power_core` perf PMU, each core's RAPL energy; the GPU's from `gpu_metrics`. Without perf, all three from `gpu_metrics` | RAPL perf PMU: package + DRAM, with the cores' and the GPU's shares |
| Memory | `/proc/meminfo`; `gpuBytes` is its `GPUActive` | `/proc/meminfo` |
| Memory bandwidth | `amd_df` perf PMU: DRAM read and write beats | `uncore_imc` perf PMU: data reads and writes |
| Fans | `/sys/class/ec_su_axb35/fanN/rpm` and `duty`, every 3 s in a thread of their own (an EC read is slow) | none |
| Network | `/proc/net/dev` bytes of the interfaces with hardware behind them (`/sys/class/net/IF/device`): not lo, bridges, veth or tunnels | same |
| Disk I/O | `/proc/diskstats` sectors of the whole disks (`/sys/block/DEV/device`): no partitions, loop, zram, dm or md | same |
| Disk space | `statvfs` of the filesystems on local block devices in `/proc/self/mounts`, one per device, at most every 5 s in a thread of its own | same |
| Energy total | a RAPL perf group of the meter's own: the package. Without perf, the `gpu_metrics` socket power integrated at every meter tick, every 2 s whether or not anyone watches; each read of `gpu_metrics` is a request to the chip's power firmware | a RAPL perf group of the meter's own: package + DRAM |

A source that is missing gives `null` in the sample; `sources` in `/v1/info` names the ones in use.

## Privileges

- `portal` role, and `llm` without engine control: `DynamicUser=yes`, `ProtectHome=yes`.
- `llm` with engine control: runs as the engine user, with `ProtectHome=read-only` and write access to the quadlet directory, `~/.local/state/portal-hostd` and the dir programs' roots only (`-` paths in `ReadWritePaths=`: a root deleted by hand does not keep it from starting).
- The only capability is `CAP_PERFMON`, for the perf PMUs. Without it there is no CPU clock, no memory bandwidth, no Intel power and energy, and Intel GPU usage comes from RC6.
- The unit also sets `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictNamespaces`, `LockPersonality`, `MemoryDenyWriteExecute`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `MemoryMax=64M`, `CPUQuota=20%`, `TasksMax=32`, `Nice=10`.
- Engine and program commands run in the engine user's systemd manager, not in this service: `systemctl --user ...`, `systemd-run --user --wait --pipe --quiet --collect podman ...` and the programs' `install.sh` the same way. Under `NoNewPrivileges` the service could not run rootless podman itself, and an install would not fit its memory and task limits.

## API

HTTP/1.1. Every request but `GET /v1/health` needs `Authorization: Bearer <token>`. Errors are `{"error": "<code>", "message": "..."}`, except what Python's `http.server` refuses itself, which gets its HTML error page: a method other than GET, POST and DELETE (501) and a malformed request (400, 414, 431, 505).

| Method and path | Answer |
|---|---|
| `GET /v1/health` | `{"ok": true}`, no token needed |
| `GET /v1/info` | `hostname`, `role`, `os`, `kernel`, `intervalMs`, `cpu`, `gpu`, `memory`, `sources`, `power`, `engine`, and what `net` and `disk` count right now: `network.interfaces`, `disks.devices`, `disks.mounts` |
| `GET /v1/sample` | One sample: `t`, `cpu`, `gpu`, `memory`, `power`, `fans`, `throttling`, `net`, `disk`. Rates are `null` in the first sample after idle. Keeps the sampler running for 5 s |
| `GET /v1/stream` | Server-sent events: `event: info` once, then `event: sample` every `INTERVAL_MS`, and `: ping` after 15 s without one. At most 4 streams. A slow reader gets the newest sample, not every one |
| `GET /v1/meter` | `instance`, `startedAt`, `t`, `energyJ`, `rxBytes`, `txBytes`: totals since this daemon started, as of its last tick (`t`). `instance` is random per start. `energyJ` is `null` without a power source, the bytes without a physical interface |
| `GET /v1/engine` | Unit state, `ready`, `unloaded` (behind llama-swap), `buildInfo`, the quadlet's image, the previous one, the local images of its repository (the listing is cached for 5 s) and the last job |
| `POST /v1/engine/pull` `{"image": "<repository>@sha256:<64 hex>"}` | 202 and the job. The repository must be the quadlet's |
| `POST /v1/engine/apply` `{"image": ..., "version": "X.Y.Z" or null}` | 202 and the job. The image must have been pulled |
| `POST /v1/engine/cancel` | `{"cancelled": true or false}`: only a running pull can be cancelled |
| `DELETE /v1/engine/images/sha256:<64 hex>` | `{"ok": true}` |
| `GET /v1/apps` | `{"apps": [...], "job": ...}`: each program that is installed (a dir program's `current` link, an image program's quadlet): `id`, `name`, `kind`, `unit`, `model`, `releases`, `version` in use, `previous`, unit `state`, `error`, the installed `versions`; and the last job |
| `POST /v1/apps/<id>/install` `{"version": ..., "image": ..., "tag": ...}` | 202 and the job. `image` (`<repository>@sha256:<64 hex>`, the quadlet's repository) and `tag` (that version's) for an image program only |
| `POST /v1/apps/<id>/apply` `{"version": ...}` | 202 and the job. The version must be installed |
| `POST /v1/apps/cancel` | `{"cancelled": true or false}`: only a running install can be cancelled |
| `DELETE /v1/apps/<id>/versions/<version>` | `{"ok": true}` |

| Status | Codes |
|---|---|
| 400 | `bad_request` (Content-Length), `invalid_json`, `invalid_image`, `wrong_repository`, `invalid_version`, `invalid_tag` |
| 401 | `unauthorized` |
| 404 | `not_found` (no such endpoint, local image or installed version), `no_engine` (no engine control on this host), `no_apps` (no `APPS_FILE`), `no_app` (no such program installed) |
| 405 | `method_not_allowed` |
| 409 | `job_running` (one job at a time, the engine's and the programs'), `not_pulled`, `image_current`, `installed`, `not_installed`, `version_current`, `rmi_failed` |
| 411 | `length_required` (chunked bodies are refused) |
| 413 | `body_too_large` (over 4096 bytes) |
| 429 | `too_many_streams` |
| 500 | `quadlet_invalid` (unreadable, or not exactly one `Image=` line), `no_install_script`, `internal` |
| 503 | `too_many_connections` (over 16), `no_sample`, `podman_failed` |

A request whose line, headers and body take more than 10 s is dropped.

An apply, which is also how to go back to an older image, runs these steps; each becomes the job's `step`:

1. Check that the image is local.
2. Save the quadlet as `~/.local/state/portal-hostd/<unit name>.container.prev`.
3. Rewrite the quadlet: only the `Image=` value changes and, with a version, the `/vX.Y.Z/` part of `Documentation=`.
   Behind llama-swap, also every other quadlet in its folder whose `Image=` is of the same repository (the image
   models), so that all of them run one release.
4. `systemctl --user daemon-reload` and `restart`. Behind llama-swap instead: `POST /api/models/unload`, wait for
   every rewritten unit to stop, then `GET /upstream/<model>/v1/models`, on which llama-swap starts the engine and
   answers once it is ready. A unit restarted behind llama-swap's back would run beside the image models.
5. Wait up to 10 minutes for the engine's `/ready` to answer 200.
6. With a version: check that `build_info` in the engine's `/props` starts with it.

If step 3 or a later one fails, the old quadlets are written back and the engine restarted the same way; the job ends `failed`, with `rolledBack: true` once the old engine answers `/ready` again. If that fails too, `rolledBack` stays `false` and `error` names both failures. When the engine did not start or answer `/ready`, `error` ends with its own last 10 log lines since the restart (`journalctl --user -u <unit>`, systemd's lines left out): why it did not start.

## Other software

`APPS_FILE` lists the programs besides the engine that the gateway may update (in the repo `llm-server/apps.json`),
by id. Each is one of two kinds:

| Key | Meaning |
|---|---|
| `name` | Shown on Admin > Updates |
| `kind` | `dir`: versions side by side under `root`, each built by `<id>/install.sh VERSION DEST`, and `root/current` a symlink to the one in use, which the program's unit starts. `image`: a quadlet of its own (`quadlet`, a file name in the engine's quadlet folder) with one `Image=` line |
| `root`, `unit` | `dir` only: the folder (`~/` is the engine user's home) and the systemd user unit |
| `model` | The program's llama-swap model: it is restarted through llama-swap, like the engine. Without one (llama-swap itself) the unit is restarted and `check` must answer 200 |
| `check` | `dir` without `model`: its `http://` health URL |
| `releases` | `tag`: a pattern over GitHub's tags (`dir`) or the registry's (`image`) whose first group is the version; `github`: owner/name of the releases and notes; `prerelease`: offer prereleases too |

A version is 1-64 letters, digits and `. + _ -`, the name of its folder. A dir program's install runs its
`install.sh` in the engine user's systemd manager into `<version>.part` for up to 3 hours, then writes
`.portal-version` into it and renames it to `<version>`: only a folder with that file counts as installed. An image
program's install pulls `<repository>:<tag>` and checks that the tag still names the digest the gateway chose.

An apply switches `current`, or the quadlet's `Image=` and `daemon-reload`, then restarts: with a model,
`POST /api/models/unload`, waiting for the unit to stop, and starting the model through llama-swap; without one,
`systemctl --user restart` and waiting for `check`. Each wait takes up to 15 minutes. If the restart fails, the old
version is put back and restarted the same way; the job ends `failed`, with `rolledBack: true` once that worked, and
`error` ends with the program's own last log lines. After it, llama-swap loads the engine's model again. The version
it replaced is saved as `~/.local/state/portal-hostd/<id>.prev`.

## Run it locally

```sh
ROLE=llm python3 hostd/portal-hostd.py --print-info --print-sample    # JSON once, no server
ROLE=llm HOSTD_TOKEN_FILE=./token python3 hostd/portal-hostd.py       # serve; the token file holds at least 32 characters
python3 -m unittest hostd/test_hostd.py                               # from the repo root; no root, no network
```

`HOSTD_ROOT=/path` reads `/proc` and `/sys` from a tree under that path, as the tests do.
