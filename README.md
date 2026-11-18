# Workspace Portal

A self-hosted portal that gives every user a coding agent in the browser, running in a container on your own
server and talking to a model you host. A user signs in and gets two workspaces, of which one runs at a time:

- **Private**: no route off the portal server. The agent reaches the model, web search and the page reader
  through the gateway, and nothing else.
- **Online**: the same, plus the public internet over TCP. It never reaches the LAN, the servers or another
  workspace. The admin can bar it per user; `ONLINE_WORKSPACES=off` turns it off for everyone.

Each workspace has its own files (`/home/user`, `/workspace`) and runs the agent the user picks in Settings:
Qwen Code or DeepSeek Harness. Web apps started in a workspace open in the browser on its preview port. The
admin manages users, watches usage and energy, updates the agents and the LLM engine, and reads the audit log.

## What runs where

| Where | What | Address (defaults) |
|---|---|---|
| Portal server | web app: sign-in, Home, Settings, admin pages | `:3000` |
| | gateway: agent ports, one per user and kind | `:3101-3299` Private, `:3301-3499` Online |
| | gateway: preview ports (agent port + 1000) | `:4101-4299`, `:4301-4499` |
| | gateway: control API, for the web app | `127.0.0.1:4002` |
| | gateway: service API, for workspaces (model, search, reader) | `172.29.0.1:4001`, `172.28.0.1:4001` |
| | one container per running workspace | a Docker network per kind |
| | SearXNG and the page reader | `127.0.0.1:8888`, `127.0.0.1:4003` |
| | portal-hostd: hardware readings | `127.0.0.1:9180` |
| LLM server (can be the same machine) | an OpenAI-compatible API | `LLM_UPSTREAM_URL` |
| | portal-hostd: readings and engine updates (optional) | `:9180`, open to the portal server only |

## Requirements

- Linux with systemd, root for the installer, and `nft`, `python3`, `openssl` and `curl`.
- Docker Engine 25.0.5 or newer with the compose plugin. Older engines let containers on internal networks
  resolve internet names (CVE-2024-29018); the installer and the gateway refuse them.
- An OpenAI-compatible model server the portal server can reach.
- firewalld is optional: the installer opens the portal's ports in it when it is active, and names them for
  another firewall. SELinux can stay enforcing: the installer labels the data directory for containers.
- The workspace UIDs (`WORKSPACE_UID_BASE`, `ONLINE_UID_BASE`) must lie outside every range in `/etc/subuid`
  and `/etc/subgid`; the installer checks.

## Install

From a checkout of this repository on the portal server:

```sh
sudo bash deploy/install.sh
```

The installer creates `.env` from [`.env.example`](.env.example) and generates the secrets, checks what only
this host can tell, prepares the data directory, builds the images, installs the firewall (an nftables table
loaded by a systemd unit that Docker requires) and portal-hostd for this server, then starts the stack and
waits until it is healthy. It keeps an existing `.env`: to set values before the first start, copy
`.env.example` to `.env` and edit it. It ends by printing the portal's URL, the port ranges, the agent
versions, where the model settings are, and the state of search, the page reader and monitoring.

First sign-in: open the URL, sign in as `admin` (`ADMIN_USERNAME`) with the password from
`grep ^ADMIN_PASSWORD .env`, and choose your own when asked. Then create the users under Users.
A lost admin password: `docker compose exec web node scripts/reset-admin-password.mjs`.

## Configure

`.env` in the repository root holds every setting; [`.env.example`](.env.example) lists each one with its
default and meaning. Look at these first:

- `LLM_UPSTREAM_URL` (without `/v1`), `LLM_API_KEY`, and `LLM_MAX_CONCURRENCY`, the model server's slots;
- `MAX_RUNNING_WORKSPACES`, `WORKSPACE_MEMORY` and `WORKSPACE_CPUS`, sized to the portal server;
- `IDLE_TIMEOUT_MINUTES` and `MAX_BUSY_HOURS`, when an unused or a long-working workspace stops;
- `FIREWALL_ALLOW_SOURCE`, who may reach the portal's ports through firewalld, and `FIREWALL_NEVER_REACH`,
  more addresses that Online workspaces, SearXNG and the page reader must never reach;
- `SESSION_COOKIE_SECURE=true` when the portal is served over HTTPS.

Run the installer again after changing `PORTAL_DATA_DIR`, `HOSTD_PORTAL_*`, `FIREWALL_*`, `WORKSPACE_AGENTS`,
an agent's `*_VERSION`, a port, subnet, `*_GATEWAY_IP`, bridge, DNS server or the server in a `*_URL`
(the firewall, portal-hostd and the images are made from them). Anything else: `docker compose up -d`.

The models are not in `.env` but in two files in Qwen Code's settings format, in
`$PORTAL_DATA_DIR/config/qwen`: `system-defaults.json` holds the models and the defaults users may change,
`settings.json` what users cannot override. DeepSeek Harness takes its models from the same files. Every model
`id` must be one the model server serves. Start from the copies in [`qwen-config/`](qwen-config); workspaces
read the installed files at their next start.

```sh
sudo bash deploy/qwen-config.sh install qwen-config/system-defaults.json qwen-config/settings.json
sudo bash deploy/qwen-config.sh check        # or: show
```

## Operate

```sh
docker compose ps                  # from the repository root
docker compose logs -f gateway     # services: web, gateway, searxng, reader
docker compose down                # stops the portal; running workspaces stay up, the gateway adopts them
docker compose up -d
sudo bash deploy/verify-isolation.sh
sudo bash deploy/update-image.sh qwen 0.28.0     # dsh: DeepSeek Harness
sudo bash deploy/update-image.sh --refresh       # rebuild the versions in use with fresh Debian packages
```

`verify-isolation.sh` checks the running portal: the host's networks and firewall, every running workspace,
the folder owners, and what a throwaway Private and Online container, the page reader and SearXNG can reach.
It prints `PASS` or `FAIL` per check, then the counts, and exits non-zero when one failed: a `FAIL` names a
guarantee of the security model that does not hold on this host. It touches no user data.

Agent versions change under Admin > Updates, which builds an image, checks it and starts the next workspaces
from it, or with `update-image.sh`, which restarts the gateway and runs the isolation check on the running
stack. Running workspaces keep their image until they stop.

Back up `.env` and the data directory (`PORTAL_DATA_DIR`): `db/` is the SQLite database (accounts, sessions,
audit log, usage, energy), `users/<id>/private` and `users/<id>/online` are the workspace files, `config/`
holds the model settings and the agent versions in use. Stop the stack for a consistent copy of `db/`, and
keep numeric owners and modes: each workspace's files belong to a UID of its own.

## Update and uninstall

```sh
git pull && sudo bash deploy/install.sh       # update
sudo bash deploy/uninstall.sh                 # keeps .env and the data directory
sudo bash deploy/uninstall.sh --purge-data    # deletes the data directory too
```

A re-run of the installer rebuilds the images and restarts what changed. It keeps `.env`, adding the settings
it lacks, the model settings and all data, and refuses while an update from Admin > Updates is running.

## LLM server: readings and engine updates

`sudo bash hostd/install.sh llm --portal <portal IPv4>` on the LLM server installs portal-hostd and prints
`HOSTD_LLM_URL` and `HOSTD_LLM_TOKEN` for the portal's `.env`. With them Admin > Usage and Energy show that
server too, and Admin > Updates updates its engine: see [hostd/README.md](hostd/README.md).

## Security model

- **A workspace** is a container that runs as a UID of its own on a read-only root, with no capabilities, no
  privilege escalation, limits on memory, CPU and processes, and only its own folders mounted. It holds no
  secret of the portal: the model's key stays in the gateway.
- **The firewall** is loaded before Docker starts. A Private workspace reaches the gateway's service port and
  nothing else. An Online workspace also reaches public IPv4 addresses over TCP, and never a private address,
  this host, its router or the servers `.env` names. SearXNG and the page reader reach the public web only.
  Without the rules the gateway runs no Online workspace.
- **A browser** reaches a workspace only on that workspace's own port, and only with the portal session of its
  user or of the admin who opened it.
- **The admin** sees accounts, running workspaces, token and energy use, and the audit log. The admin can
  open a user's workspace, files and conversations included: the audit log records it and the user sees
  "Admin connected" meanwhile. The database stores no prompt and no answer, and passwords only as argon2id
  hashes. Root on the portal server can read every workspace's files.

The contracts behind this are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```sh
npm ci                # Node.js 24 or newer; an npm workspace of packages/core, gateway and web
npm test              # all three; the gateway's integration tests need no Docker
npm run typecheck
npm run build         # the gateway bundle, then the web app
python3 -m unittest hostd/test_hostd.py
```

The page reader's tests run in its image build. `npm run dev -w @portal/gateway` runs the gateway from source
with the settings in `.env`; it needs Docker and a data directory it can write. `npm run dev -w @portal/web`
runs the web app on port 3000 with the settings in its environment. Licensed under [Apache-2.0](LICENSE).
