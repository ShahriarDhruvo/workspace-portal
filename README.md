# Workspace Portal

A self-hosted portal that gives every user a coding agent in the browser, running in a container on your own
server and talking to a model you host. A user signs in, picks an agent on Home (Qwen Code, DeepSeek Harness
or OpenCode) and starts its workspace, of one of two kinds:

- **Private**: no route off the portal server. The agent reaches the model, web search and the page reader
  through the gateway, and nothing else.
- **Online**: the same, plus the public internet over TCP. It never reaches the LAN, the servers or another
  workspace. The admin can bar it per user; `ONLINE_WORKSPACES=off` turns it off for everyone.

Every agent has a Private and an Online workspace of its own for each user, and each workspace has its own
files (`/home/user`, `/workspace`) and chats: nothing is shared between them, and one of a user's workspaces
runs at a time. A web server started in a workspace opens from the Preview button in the portal's bar, in a tab
of its own. With a key from the API page, a user's other software (an editor, a script) uses the same model
through the portal. The admin manages users, watches usage and energy, updates the agents and the LLM engine,
and reads the audit log.

## In a workspace

Whichever agent runs it, a workspace has Node.js 24 with npm and pnpm, Python 3 with uv and ruff, Go, Rust
(cargo, rustfmt, clippy), GCC and G++ with make and gdb, Bash with shellcheck and shfmt, PowerShell, git and a
headless Chromium for the agent's browser tools. They are in the image, because a Private workspace can download
nothing. OpenCode also starts with two plugins, five skills, formatting after edits and, in an Online workspace,
two public MCP servers: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#opencodes-toolset) lists them and what was
left out.

## What runs where

| Where | What | Address (defaults) |
|---|---|---|
| Portal server | web app: sign-in, Home, API, Settings, admin pages; the LLM API under `/llm/api` | `:3000` |
| | gateway: agent ports, one per user, enabled agent and kind | `:12020-13999`, a block of 20 per user |
| | gateway: preview ports (agent port + 10000), for the web servers in a workspace | `:22020-23999` |
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
- The workspace UIDs (20 per user from `WORKSPACE_UID_BASE`) must lie outside every range in `/etc/subuid`
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
  more addresses that Online workspaces, SearXNG and the page reader must never reach.

Run the installer again after changing `PORTAL_DATA_DIR`, `HOSTD_PORTAL_*`, `FIREWALL_*`, `WORKSPACE_AGENTS`,
an agent's `*_VERSION`, a port, subnet, `*_GATEWAY_IP`, bridge, DNS server or the server in a `*_URL`
(the firewall, portal-hostd and the images are made from them). Anything else: `docker compose up -d`.

`WORKSPACE_AGENTS` lists the agents the portal offers. One that is not listed is off everywhere: Home does not
show it, its ports are closed, its image is not built, and a workspace of it that still runs is stopped. Its
users' files stay.

The models are not in `.env` but in two files in Qwen Code's settings format, in
`$PORTAL_DATA_DIR/config/models`: `system-defaults.json` holds the models and the defaults users may change,
`settings.json` what users cannot override. Every agent takes its models from these files. Every model `id`
must be one the model server serves. Start from the copies in [`models/`](models); workspaces read the
installed files at their next start.

```sh
sudo bash deploy/models.sh install models/system-defaults.json models/settings.json
sudo bash deploy/models.sh check        # or: show
```

Every agent is told the facts of its workspace: what is kept, what its network reaches, which tools are
installed, and that a web server must listen on `0.0.0.0` for the Preview button. To add your own instructions
for every agent of every user (how to answer, how to write code), write them as Markdown, at most 32 KiB, to
`$PORTAL_DATA_DIR/config/instructions.md`. The file is not in the repository, so it may hold what is personal.
Workspaces read it at their next start.

```sh
sudo install -m 0600 my-instructions.md /srv/workspace-portal/config/instructions.md
```

## HTTPS

Plain HTTP is for a LAN you trust. With [Tailscale](https://tailscale.com) on the portal server, and MagicDNS and
HTTPS certificates enabled for the tailnet:

```sh
sudo bash deploy/tailscale-https.sh         # with "off": back to HTTP on the LAN
```

Tailscale then ends TLS under the server's name in the tailnet: on port 443 for the portal, so its URL needs no
port, and on each workspace's own port. The script binds the ports to 127.0.0.1, sets `PORTAL_HTTPS=true` and
prints the URL. From then on only the tailnet's devices reach the portal; which of them is for the tailnet's
access rules, because `FIREWALL_ALLOW_SOURCE` no longer applies. The mapped ports are those in `.env`: run the
script with `off` before changing a port or uninstalling the portal, and again after the change.

Over HTTPS a browser offers to install the portal as an app: Chrome on Android under "Add to Home screen",
Safari on an iPhone under Share > Add to Home Screen.

## LLM API

On the API page a user creates up to five keys, names each after the software that gets it, and revokes them.
The page gives the base URL and the model's name to enter, and shows per key and per day the requests, the
tokens in and out, and the electricity with its cost. A key opens the model server's API under the portal's
address:

```sh
curl https://<portal>/llm/api/v1/models -H "Authorization: Bearer $KEY"
```

Software that speaks the OpenAI API takes `https://<portal>/llm/api/v1` as its base URL and the key as its API
key; `x-api-key` carries the key as well. Every path, method, header and body reaches the model server as it
was sent, with `LLM_API_KEY` in the user's key's place, and the answer streams back. A body may be 64 MiB.
Generations wait in the workspaces' queue, within the same limit per user (`LLM_MAX_CONCURRENCY_PER_USER`).

## Operate

```sh
docker compose ps                  # from the repository root
docker compose logs -f gateway     # services: web, gateway, searxng, reader
docker compose down                # stops the portal; running workspaces stay up, the gateway adopts them
docker compose up -d
sudo bash deploy/verify-isolation.sh
sudo bash deploy/update-image.sh qwen 0.28.0     # dsh: DeepSeek Harness, opencode: OpenCode
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
API keys, audit log, usage, energy), `users/<id>/<agent>/private` and `users/<id>/<agent>/online` are the
workspace files (`<agent>` is `qwen`, `dsh` or `opencode`), `config/` holds the model settings, your
instructions and the agent versions in use. Stop the stack for a consistent copy of `db/`, and keep numeric
owners and modes: each workspace's files belong to a UID of its own.

## Update and uninstall

```sh
git pull && sudo bash deploy/install.sh       # update
sudo bash deploy/uninstall.sh                 # keeps .env and the data directory
sudo bash deploy/uninstall.sh --purge-data    # deletes the data directory too
```

A re-run of the installer rebuilds the images and restarts what changed. It keeps `.env`, adding the settings
it lacks, the model settings and all data, and refuses while an update from Admin > Updates is running. An agent
the portal has gained since the install (OpenCode) stays off, because `WORKSPACE_AGENTS` in `.env` is kept: add
`opencode` to it and run the installer again.

An install from before every agent had its own workspaces (its `.env` has `ONLINE_AGENT_PORT_BASE`) updates
once in another way, because the ports, the UIDs and the folders are numbered anew. People start with empty
workspaces afterwards.

1. Stop every workspace: the new gateway removes any that the old one started.
2. Close the old ports before `git pull`, because the old scripts know them and the new ones would look for
   the new ports: with firewalld, `sudo bash -c 'source deploy/lib.sh && firewalld_rules remove'`; behind
   HTTPS, `sudo bash deploy/tailscale-https.sh off`. After the pull instead: `sudo tailscale serve reset`
   unmaps everything this machine serves through Tailscale, and firewalld's rules for the old ports stay
   until taken out by hand (`firewall-cmd --permanent --list-rich-rules` shows them).
3. `git pull`, then in `.env` set `AGENT_PORT_BASE=12000` and `AGENT_PORT_COUNT` above the highest user id
   (`.env.example` has 100), and delete `ONLINE_AGENT_PORT_BASE` and `ONLINE_UID_BASE`, which nothing reads.
4. Delete the old folders `users/<id>/private` and `users/<id>/online` in the data directory, after saving
   what is to be kept: no workspace uses them, and `verify-isolation.sh` fails while they are there.
5. `sudo bash deploy/install.sh`, and behind HTTPS `sudo bash deploy/tailscale-https.sh` again.

[docs/GUIDE.md](docs/GUIDE.md#update-the-portal) has these steps as commands, and how to move a person's old
files into one of the new workspaces.

## LLM server: readings and engine updates

`sudo bash hostd/install.sh llm --portal <portal IPv4>` on the LLM server installs portal-hostd and prints
`HOSTD_LLM_URL` and `HOSTD_LLM_TOKEN` for the portal's `.env`. With them Admin > Usage and Energy show that
server too, and Admin > Updates updates its engine: see [hostd/README.md](hostd/README.md).

[`llm-server/`](llm-server) holds what the reference LLM server runs: the engine's service file, a full-load
test, and fan control for the one board it was tested on. [docs/GUIDE.md](docs/GUIDE.md) sets up both servers
step by step from a fresh Fedora, the model download included.

## Security model

- **A workspace** is a container that runs as a UID of its own on a read-only root, with no capabilities, no
  privilege escalation, limits on memory, CPU and processes, and only its own folders mounted. No two
  workspaces share a UID, a folder, a port or a browser token, one user's included. It holds no secret of the
  portal: the model's key stays in the gateway.
- **The firewall** is loaded before Docker starts. A Private workspace reaches the gateway's service port and
  nothing else. An Online workspace also reaches public IPv4 addresses over TCP, and never a private address,
  this host, its router or the servers `.env` names. SearXNG and the page reader reach the public web only.
  Without the rules the gateway runs no Online workspace.
- **A browser** reaches a workspace only on that workspace's own port, and only with the portal session of its
  user or of the admin who opened it. A web server in a workspace is reached the same way, on the workspace's
  preview port: an origin of its own, so its pages share nothing with the agent's or the portal's.
- **An API key** opens the model server's API and nothing of the portal. The database keeps only its hash. It
  stops working when it is revoked or its user is deactivated. With a hosted provider as the model server it
  opens that provider's whole API on your account, not only the routes a workspace gets.
- **The admin** sees accounts, running workspaces, token and energy use, and the audit log. The admin can
  open a user's workspace, files and conversations included: the audit log records it and the user sees
  "Admin connected" meanwhile. The database stores no prompt and no answer, and passwords only as argon2id
  hashes. Root on the portal server can read every workspace's files.

The contracts behind this are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```sh
npm ci                # Node.js 24 or newer; npm workspaces: packages/core, harnesses, container, gateway, web
npm test              # all five; the gateway's integration tests need no Docker
npm run typecheck
npm run build         # the gateway bundle, then the web app
python3 -m unittest hostd/test_hostd.py llm-server/fans/test_fans.py
```

The page reader's tests run in its image build. `npm run dev -w @portal/gateway` runs the gateway from source
with the settings in `.env`; it needs Docker and a data directory it can write. `npm run dev -w @portal/web`
runs the web app on port 3000 with the settings in its environment. Licensed under [Apache-2.0](LICENSE), except the kernel module in
`llm-server/fans`, which is [GPL-2.0](llm-server/fans/COPYING).
