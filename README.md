# Workspace Portal

A private web portal that gives every user their own AI coding workspace: a container running the
[Qwen Code](https://github.com/QwenLM/qwen-code) Web Shell (`qwen serve`), with a shell, files, a
headless browser and web search, all driven by a model you host.

- Username/password sign-in. One admin creates the users (first, middle and last name).
- **One container per user**, shared by all of that user's sign-ins (two browsers, two devices: same workspace).
- It starts at sign-in. It stops when the user signs out, or after 30 minutes without use, **but never while
  the agent is working**. A long task keeps running after the user leaves, and the workspace stops once the task is done.
- The admin sees every workspace's state and can open any of them, even while the user is in it.
- **Locked down by default:** a workspace can reach exactly two things, the model provider and the search
  engine, and only through the portal's gateway. It has no internet access, can't reach your LAN or other
  workspaces, and has nothing mounted except the user's own files.

```
 browser ──:3000──▶ web (Next.js)  ── sign-in, admin console, starts/stops workspaces
    │                   │ control API (127.0.0.1:4002)
    └──:3100+id──▶ gateway ────────── Docker ──▶ wp-ws-<id>  (Qwen Code, one per user)
                        ▲                              │
                        └─ 172.29.0.1:4001 ◀───────────┘ the only address a workspace can reach
                               ├─ /llm/v1    ──▶ LLM_UPSTREAM_URL (your model server)
                               └─ /mcp/search ─▶ SEARXNG_URL       (your SearXNG)
```

## Contents

- [Security model](#security-model)
- [Requirements](#requirements)
- [Install and start the web server](#install-and-start-the-web-server)
- [Connect the model](#connect-the-model)
- [Connect your SearXNG search engine](#connect-your-searxng-search-engine)
- [Qwen Code settings for all workspaces](#qwen-code-settings-for-all-workspaces)
- [Updating the workspace image](#updating-the-workspace-image)
- [Using it](#using-it)
- [Remote access with Tailscale](#remote-access-with-tailscale)
- [Operations](#operations)
- [Development](#development)
- [Limitations](#limitations)
- [License](#license)

## Security model

Each item is enforced by the gateway or the host, not by the agent. `deploy/verify-isolation.sh` checks the
network and container items on a live install.

**Network: two destinations, nothing else**
- Workspaces sit on a Docker *internal* network: Docker gives it no route off the host. There is no DNS for
  internet names, no NAT and no IPv6.
- Inter-container traffic is disabled, so a workspace can't reach another workspace.
- The one address a workspace can reach is the host side of that network (`172.29.0.1`). A host firewall
  (`deploy/firewall.sh`: an nftables table of its own, `inet workspace_portal`, loaded at boot by
  `workspace-portal-firewall.service`) drops every connection from the workspace network except the one to
  the gateway's service port. SSH, the portal, the LLM server and SearXNG on the host are all unreachable,
  and nothing from the workspace network is forwarded anywhere. A drop in nftables is final, so rules that
  Docker, firewalld or Tailscale add elsewhere can't reopen it.
- On that port the gateway serves only:
  - the model: chat completions, completions, embeddings and the model list under `/llm/v1/`, forwarded to
    `LLM_UPSTREAM_URL` with your real API key added (any other path of the model server is refused);
  - web search: an MCP `web_search` tool that sends the query to `SEARXNG_URL` and returns titles, links and
    snippets.

  There is no URL-fetch tool and no proxy, so nothing else on the internet is reachable.
- Qwen Code's own internet features are off and pinned at system scope:
  - auto-update, usage statistics, telemetry, the model catalogue refresh;
  - `web_fetch` is denied, and built-in web search providers are removed.

  With them off, a running workspace made no outside DNS lookups in testing.

**Files: only the user's own**
- User N's workspace runs as its own UID (`WORKSPACE_UID_BASE + N`, 200000+N by default). That UID owns two
  directories, the user's home and workspace, and nothing else on the host.
- The container's root filesystem is read-only. Writable are `/home/user`, `/workspace` (the user's storage)
  and an in-memory `/tmp`.
- The rest is mounted read-only and is a per-user copy:
  - the Qwen Code settings (`/etc/workspace-portal/qwen/`);
  - `/etc/passwd` and `/etc/group`.

  No directory, socket or file is shared between workspaces.
- A workspace gets files only two ways: uploads into its own storage, and what the agent produces from the
  model and search results.

**Privileges**
- All capabilities are dropped, with no-new-privileges and memory, CPU and PID limits. The image has no
  setuid or setgid programs and no user accounts of its own.
- `tini` runs as PID 1, and the OOM killer picks workspaces before the LLM server.
- The default seccomp profile applies, plus SELinux confinement on Fedora/RHEL.

**Credentials**
- The LLM API key and SearXNG credentials stay in the gateway; a workspace sees a placeholder key. Each of
  the two portal containers gets only the settings it uses: the web app never sees those credentials, and
  the gateway never sees the admin password.
- Each container start gets a fresh random token for its `qwen serve`. It lives only in the gateway and in
  that container.
- The browser gets a different token, derived from its portal session and that one workspace. The gateway
  accepts it only together with the session cookie, and swaps it for the container's token.
- Sessions use an HttpOnly, SameSite=Lax cookie; passwords are hashed with Argon2id. Five failed sign-ins
  lock an account for 15 minutes.

**Browser isolation**
- Every workspace is served on its own port (`AGENT_PORT_BASE + user id`), so it is a separate browser origin.
  Its storage, service worker and scripts can't see another user's workspace, even in the same browser.
- A session can use only the workspace it has open. An admin's session can use another user's workspace only
  after opening it from the admin console, which writes to the audit log.

**What the admin can do:** read and use every workspace. That is by design.

## Requirements

- Linux with Docker Engine 25.0.5 or newer and the compose plugin, `nftables` (the `nft` command), `python3`,
  `openssl`, `curl`. Tested on Fedora 44 with Docker 29. Older Docker engines let containers on internal
  networks resolve internet names (CVE-2024-29018), so the installer and the gateway refuse them.
- An OpenAI-compatible model server (llama.cpp, vLLM, Ollama, a hosted API). It runs anywhere the server can reach.
- A SearXNG instance with the JSON output format enabled (optional; without it searches return an error).
- RAM: about 0.5 GB per idle workspace and up to `WORKSPACE_MEMORY` (3 GB) under load.

## Install and start the web server

```sh
git clone <this repository> workspace-portal
cd workspace-portal
sudo bash deploy/install.sh
```

The installer is idempotent; re-run it after pulling changes. It:

1. checks the host: Docker version, `nft`, and that workspace UIDs don't overlap a range in `/etc/subuid`;
2. creates `.env` from `.env.example` (mode 600), generating `GATEWAY_CONTROL_SECRET` and an `ADMIN_PASSWORD`;
3. creates `PORTAL_DATA_DIR` (`/srv/workspace-portal`) with the ownership model above, plus the SELinux labels;
4. installs the example Qwen Code settings into `PORTAL_DATA_DIR/config/qwen/` (never overwriting yours);
5. builds the workspace image for `QWEN_CODE_VERSION` (a few minutes the first time) and the web and gateway images;
6. installs and starts the workspace firewall unit, and opens ports 3000 and 3101–3299 to your LAN (and to
   Tailscale, if present) in firewalld or ufw;
7. starts the stack with `docker compose up -d` and prints the URL.

From a development machine you can push and install in one step: `deploy/deploy.sh user@server`. It rsyncs
the tree, keeping the server's `.env`.

Edit `.env` before the first install if you need different ports, paths or limits. Every variable is
documented in `.env.example`. Changing a port or a `WORKSPACE_*` network setting later needs a re-run of the
installer, which regenerates the firewall from them; other settings need only `docker compose up -d`.

**Starting, stopping and restarting the web server.** Run these in the project directory on the server, with
sudo unless you are in the `docker` group:

```sh
docker compose up -d            # start (or apply .env changes)
docker compose restart          # restart web + gateway; running workspaces keep running
docker compose down             # stop the portal; workspaces stay until the gateway stops them
docker compose ps               # status
docker compose logs -f web gateway
```

The stack starts at boot (Docker is enabled by the installer). Open `http://<server>:3000` and sign in as
`admin`. The initial password is in `.env`:

```sh
grep ^ADMIN_PASSWORD .env
```

At that first sign-in the portal asks you to choose a new password. `ADMIN_PASSWORD` is only used to create
the admin account; changing the password in the portal doesn't update it.

## Connect the model

Workspaces talk to the gateway, and the gateway talks to your model server, so only the server needs to reach it.

1. Set the provider in `.env`:

   ```sh
   # Base URL WITHOUT /v1: the gateway forwards /v1/chat/completions etc. unchanged.
   LLM_UPSTREAM_URL=http://127.0.0.1:8080          # llama.cpp / vLLM on this host
   # LLM_UPSTREAM_URL=http://10.0.0.5:8000         # a model server elsewhere on your network
   # LLM_UPSTREAM_URL=https://api.example.com      # a hosted OpenAI-compatible API
   LLM_API_KEY=                                    # sent as "Authorization: Bearer …"; empty for none
   LLM_MAX_CONCURRENCY=3                           # match the server's parallel slots
   LLM_MAX_CONCURRENCY_PER_USER=2
   ```

   For a provider whose base URL ends in `/v1` (for example `https://openrouter.ai/api/v1`), drop the `/v1`
   (`https://openrouter.ai/api`).

2. Choose the models users see. They are listed under `modelProviders.openai` in Qwen Code's
   `system-defaults.json`, one entry per model: `id` is the name the model server expects (an `id` from
   `/v1/models`), and the entry also sets the display name, context window, output limit, image input,
   reasoning effort levels and sampling parameters. `model.name` picks the default. Start from
   `qwen-config/system-defaults.json`, which the installer has already put in place, and install your
   version as described in [Qwen Code settings](#qwen-code-settings-for-all-workspaces):

   ```sh
   cp qwen-config/system-defaults.json /tmp/system-defaults.json   # then edit "id", "name", limits, …
   sudo bash deploy/qwen-config.sh install /tmp/system-defaults.json
   ```

   The portal rewrites each entry's `baseUrl` to the gateway and its key to a placeholder, so leave them
   out and never put real keys there. A workspace won't start without at least one model.

3. Apply the change:

   ```sh
   docker compose up -d     # after .env changes: restarts the gateway with the new provider
   ```

   Workspaces pick up model changes at their next start. Stop running ones in the admin console to apply now.

4. Check it from the server: `curl -s "$LLM_UPSTREAM_URL/v1/models"` should list your model. In a workspace,
   ask the agent anything. The gateway logs one JSON line per model request (`docker compose logs gateway`).

   If the chat shows `404 model '…' is not served`, the model `id` in `system-defaults.json` doesn't match an
   `id` from `/v1/models`. Fix it, then stop the workspace so it restarts with the new settings.
   A reply that never comes usually means the model server is busy with other requests: the gateway's
   `/control/stats` shows `llm.inFlight`, and the server's own log shows its queue.

## Connect your SearXNG search engine

The agent's `web_search` tool is served by the gateway, which queries your SearXNG instance.

1. Enable JSON output in SearXNG's `settings.yml`, then restart SearXNG:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

2. Point the portal at it in `.env`:

   ```sh
   SEARXNG_URL=http://127.0.0.1:8888              # as the server reaches it; may include a path prefix
   SEARXNG_AUTHORIZATION=                         # optional, for an instance behind auth: "Basic …" or "Bearer …"
   SEARXNG_TIMEOUT_SECONDS=20
   SEARCH_MAX_CONCURRENT_PER_USER=2
   ```

3. Apply the change with `docker compose up -d`. It takes effect immediately, with no workspace restart.

4. Check it from the server: `curl -s "$SEARXNG_URL/search?q=test&format=json" | head -c 300` must return JSON.
   A `403` means the JSON format is still disabled.

Only the query text, page, time range and language are sent to SearXNG. The workspace never contacts it
directly. The gateway's `limiter` setting in SearXNG (if you use its bot protection) sees the gateway's
address, so allow it there.

## Qwen Code settings for all workspaces

Every workspace starts `qwen serve` with two system settings files that the admin provides:

| File | Scope | Typical content |
|---|---|---|
| `settings.json` | **system**: overrides what users set | permissions, extra MCP servers, UI defaults, anything users must not change |
| `system-defaults.json` | **defaults**: users may change these in their own settings | `modelProviders`, the default `model`, reasoning effort |

Both are [Qwen Code settings files](https://qwenlm.github.io/qwen-code-docs/) (JSON; `//` comments allowed).
Start from the examples in `qwen-config/`.

**Upload** your files on the server; they are validated before they are installed:

```sh
sudo bash deploy/qwen-config.sh install /path/to/settings.json /path/to/system-defaults.json
sudo bash deploy/qwen-config.sh show      # what is installed
sudo bash deploy/qwen-config.sh check     # validate the installed files
```

They are stored in `PORTAL_DATA_DIR/config/qwen/` (root-owned; workspaces never see this directory).
You can upload one file or both; the name decides which is which.

**When they apply.** At every workspace start the gateway renders a private copy for that user into
`PORTAL_DATA_DIR/users/<id>/system/qwen/` and mounts it read-only. New settings therefore apply at each
workspace's next start. To apply them right away, stop the running workspaces in the admin console; each one
starts again when its user opens it. An invalid file makes starts fail with a message naming it, shown in the
portal and in `docker compose logs gateway`.

**What the portal always enforces** on top of your files, because the isolation depends on it:

- `mcpServers.search`: the portal's web search. With `WORKSPACE_BROWSER=true`, also `mcpServers.browser`
  (headless Chromium inside the workspace). Your other MCP servers are kept. Stdio servers run inside the
  workspace; HTTP servers elsewhere are unreachable.
- `modelProviders.openai[*].baseUrl` goes to the gateway, `envKey` to a placeholder, and `apiKey` is removed.
  Only OpenAI-compatible providers are kept.
- `security.auth.enforcedType` and `selectedType`: `openai`.
- Off: `general.enableAutoUpdate`, `general.preventSystemSleep`, `privacy.usageStatisticsEnabled`,
  `telemetry.enabled`, `model.catalogRefresh`.
- `permissions.deny` includes `web_fetch`, and `tools.webSearch` (built-in providers) is removed.

Users keep their own Qwen Code settings, chats and memory in their home directory, which survives restarts.

## Updating the workspace image

The workspace image is built from `workspace-image/` and tagged `workspace-portal/workspace:qwen-<version>`.
`QWEN_CODE_VERSION` in `.env` selects the Qwen Code version, and with it the image every workspace starts from.

**Change the Qwen Code version** (on the server, in the project directory):

```sh
sudo bash deploy/update-image.sh 0.28.0
```

This builds the image for that version, checks that it really contains it, sets `QWEN_CODE_VERSION` in
`.env`, restarts the gateway and runs `deploy/verify-isolation.sh` against the new image. Running workspaces
keep the old image until they stop; every new start uses the new one. To move everyone now, stop the running
workspaces in the admin console.

**Roll back** the same way: `sudo bash deploy/update-image.sh 0.27.0` (the old image is still there, so
nothing is rebuilt).

**Security updates** for Chromium and the other Debian packages:

```sh
sudo bash deploy/update-image.sh --refresh     # rebuild the current version from a fresh base image
```

**Add tools or change other versions** by editing `workspace-image/Dockerfile` (for example an
`apt-get install` line, or `ARG PLAYWRIGHT_MCP_VERSION`), then run `update-image.sh --refresh`. Keep the image
free of credentials.

Remove old images when you no longer need them: `sudo docker image rm workspace-portal/workspace:qwen-0.27.0`.

Check Qwen Code's release notes before upgrading: the gateway relies on `qwen serve`'s token auth and
`/health?deep=1`. If either changes, the workspace start and `verify-isolation.sh` show it.

## Using it

1. **Admin → New user** creates an account with a one-time temporary password. The user chooses their own at
   first sign-in.
2. Signing in opens the workspace: the container starts (a few seconds) and the Qwen Code Web Shell appears,
   in dark mode. The page loads it from that user's own port (`3100 + user id`), which must be reachable.
3. **One container per user.** More sign-ins (another tab, browser or device) attach to the same container
   and see the same sessions live.
4. **When it stops:**
   - after `IDLE_TIMEOUT_MINUTES` (30) without use, when nothing is running;
   - soon after the user signs out on every device, when nothing is running;
   - when an admin stops it (immediately; the dialog warns if the agent is working).

   It never stops while the agent is working: generating, running a tool or command, waiting for an
   approval, a subagent, a background task, or using the CPU. The idle countdown starts when the work ends. A user who signs out
   mid-task is told the workspace will stop by itself once the task is done.

   Two safety nets stop runaway cases:
   - an approval prompt nobody answers is declined after `IDLE_TIMEOUT_MINUTES`;
   - after `MAX_BUSY_HOURS` (24) without anyone using the workspace, work no longer keeps it running.
5. **Admin console:** see every workspace (running, working, idle time, memory), and open, stop, deactivate,
   reset or delete any user. Opening a user's workspace shows them an "Admin connected" notice and is
   audit-logged.
6. When all `MAX_RUNNING_WORKSPACES` slots are taken, a new start replaces the workspace that has been idle
   longest (over 5 minutes, and never a working one). If there is none, the user sees "try again".

## Remote access with Tailscale

The simplest setup uses the tailnet directly. Tailscale already encrypts the traffic end to end.

1. Install Tailscale on the server and run `tailscale up`.
2. Re-run `sudo bash deploy/install.sh`. When a `tailscale0` interface exists, it also opens 3000 and
   3101–3299 to Tailscale addresses (100.64.0.0/10). With firewalld you can instead put `tailscale0` in a
   trusted zone.
3. Users open `http://<machine>.<tailnet>.ts.net:3000` (MagicDNS) or `http://100.x.y.z:3000`. The workspace
   iframe follows the page's host automatically.

To keep the portal off the LAN entirely, set `FIREWALL_ALLOW_SOURCE=100.64.0.0/10` in `.env` before running
the installer, and remove any LAN rules it added earlier (`sudo firewall-cmd --list-rich-rules`).

The pages are then plain HTTP over the encrypted tunnel, so browsers don't treat them as a "secure context".
Clipboard buttons may ask for permission, and Qwen Code's voice mode is unavailable. HTTPS through
`tailscale serve` would need one serve rule per workspace port. That works in principle, but it is untested
and not set up by the installer.

## Operations

All commands run in the project directory on the server.

```sh
docker compose ps                                              # status
docker compose logs -f gateway web                             # logs (JSON lines)
docker ps --filter label=workspace-portal.workspace=1          # running workspaces (wp-ws-<user id>)
sudo bash deploy/verify-isolation.sh                           # prove a workspace reaches only the gateway
sudo nft list table inet workspace_portal                      # the workspace firewall rules
docker compose exec web node scripts/reset-admin-password.mjs  # forgot the admin password: prints a temporary one
```

**Data** lives in `PORTAL_DATA_DIR` (`/srv/workspace-portal`):

- `db/portal.sqlite`: accounts, sessions, audit log, LLM usage. It runs in WAL mode; back it up with
  `sqlite3 portal.sqlite ".backup /path/backup.sqlite"`, or stop the stack first.
- `users/<id>/home`: Qwen Code state (`~/.qwen`: chats, memory, the user's settings) and caches.
- `users/<id>/workspace`: the user's files, `/workspace` in the container.
- `users/<id>/system`: the rendered settings and passwd/group, regenerated at every start.
- `config/qwen`: the admin's Qwen Code settings.

Deleting a user in the admin console removes their directory.

**Uninstall:**

```sh
sudo bash deploy/uninstall.sh               # removes the stack, workspaces, firewall and images; keeps the data
sudo bash deploy/uninstall.sh --purge-data  # also deletes PORTAL_DATA_DIR (every account and file)
```

## Development

```sh
npm install
npm run typecheck && npm test && npm run build
npm run dev -w @portal/gateway   # needs Docker; reads ../.env
npm run dev -w @portal/web       # http://localhost:3000; web/test/mock-gateway.mjs fakes the gateway for UI work
```

Layout:
- `web/` is the Next.js portal.
- `gateway/` holds the workspace manager, proxies, LLM queue and search MCP.
- `packages/db/` is the SQLite schema shared by both.
- `workspace-image/` is the Qwen Code container.
- `qwen-config/` holds the example settings.
- `deploy/` has the installer, firewall, config upload, image update, uninstaller and isolation check
  (`lib.sh` holds what they share).

`docs/ARCHITECTURE.md` describes the internals and every API.

## Limitations

- Single host: workspaces run next to the portal. `MAX_RUNNING_WORKSPACES` caps them (4 by default).
- Up to `AGENT_PORT_COUNT - 1` users (199 by default), because each user's workspace has its own port. Raise
  `AGENT_PORT_COUNT` (and re-run the installer to open the ports) for more.
- The admin can see everything in every workspace.
- Plain HTTP on the LAN: use Tailscale (above) or a VPN when you leave it.
- The LLM queue is per gateway process. Usage is counted per user per day in `llm_usage`, but not shown in the
  UI yet.

## License

[Apache License 2.0](LICENSE).
