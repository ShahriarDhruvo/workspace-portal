# Workspace Portal

A web portal on one server that gives each user an AI coding workspace in a locked-down container: Qwen Code or
DeepSeek Harness, driven by a model you host. Internals, APIs and the security model: `docs/ARCHITECTURE.md`.

1. [Install and start](#1-install-and-start)
2. [What runs after the install](#2-what-runs-after-the-install)
3. [What can break on upgrades](#3-what-can-break-on-upgrades)

## 1. Install and start

**Requirements:** Linux with Docker Engine 25.0.5 or newer and the compose plugin, `nft`, `python3`, `openssl`
and `curl` (tested on Fedora 44 with Docker 29). An OpenAI-compatible model server the host can reach. RAM:
about 0.4 GB for the portal, 0.5 GB per idle workspace, up to 3 GB per busy one.

```sh
git clone <this repository> workspace-portal
cd workspace-portal
cp .env.example .env            # optional: edit ports, paths or limits first (every setting is explained there)
sudo bash deploy/install.sh
```

The installer is idempotent. It:

1. checks the host (Docker version, `nft`, port and UID ranges);
2. creates `.env` if missing (mode 600) and fills in `GATEWAY_CONTROL_SECRET` and `ADMIN_PASSWORD`;
3. creates the data directory `/srv/workspace-portal` with its owners and SELinux labels;
4. builds every image: web, gateway, SearXNG, page reader, and one workspace image per agent;
5. installs the host firewall and opens the portal's ports to your LAN, and to Tailscale when `tailscale0`
   exists (firewalld or ufw);
6. starts the stack with `docker compose up -d` and prints the URL.

Open `http://<server>:3000` and sign in as `admin` with the password from `grep ^ADMIN_PASSWORD .env`. The
portal asks for a new password at that first sign-in.

### Connect the model

1. In `.env`, set the model server's base URL **without** `/v1`:

   ```sh
   LLM_UPSTREAM_URL=http://127.0.0.1:8080
   LLM_API_KEY=                   # sent as "Authorization: Bearer ..."; empty for none
   LLM_MAX_CONCURRENCY=3          # the model server's parallel slots
   ```

2. List the models users can pick in Qwen Code's `system-defaults.json` (both agents use it). Each entry's `id`
   must be an `id` from `$LLM_UPSTREAM_URL/v1/models`; leave out `baseUrl` and keys, the portal sets them:

   ```sh
   cp qwen-config/system-defaults.json /tmp/system-defaults.json     # edit it
   sudo bash deploy/qwen-config.sh install /tmp/system-defaults.json
   ```

3. `sudo docker compose up -d`. Workspaces pick up model changes at their next start.

### Server monitoring and LLM engine updates

The installer sets up `portal-hostd` on the portal server. For the LLM server's readings and one-click engine
updates in the admin console, install it there too (it prints two lines for the portal's `.env`, then run
`sudo docker compose up -d` on the portal):

```sh
sudo bash workspace-portal/hostd/install.sh llm --portal <portal server IP>
```

### Start, stop, update

In the project directory on the server:

```sh
sudo docker compose up -d                   # start, or apply .env changes
sudo docker compose restart web gateway     # restart the portal; running workspaces keep running
sudo docker compose down                    # stop the portal
sudo docker compose ps                      # status
sudo docker compose logs -f gateway web     # logs
sudo bash deploy/uninstall.sh               # remove the stack, workspaces, firewall and images; keeps the data
```

The stack and the firewall start at boot. Changing a port, subnet, bridge or DNS setting in `.env` needs a
re-run of the installer (the firewall is generated from them); other settings need only `docker compose up -d`.

**Update the portal** when no agent is working (the admin console shows it); running workspaces keep running:

```sh
git pull --ff-only
sudo bash deploy/install.sh
sudo bash deploy/verify-isolation.sh        # must end with "failed 0"
```

## 2. What runs after the install

| Service | What it does | Listens on |
|---|---|---|
| `web` (container) | the portal: sign-in, Home, Settings, admin console | `:3000` (LAN, Tailscale) |
| `gateway` (container) | starts and stops workspaces and serves them to the browser; the LLM proxy and queue; the agents' `web_search` and `read_page` tools; usage, energy and updates | workspaces: `:3101-3299` Private, `:3301-3499` Online; the apps inside them (Web preview): `:4101-4299` Private, `:4301-4499` Online; `127.0.0.1:4002` control API; `172.29.0.1:4001` and `172.28.0.1:4001`, the only address a workspace can reach |
| `searxng` (container) | web search behind `web_search` | `127.0.0.1:8888` |
| `reader` (container) | fetches one public page or PDF as text for `read_page` | `127.0.0.1:4003` |
| `wp-ws-<id>` / `wp-wo-<id>` (containers) | a user's Private or Online workspace: Qwen Code (`qwen serve`) or DeepSeek Harness (`dsh`), with a shell, files and headless Chromium. Started by the user's Start, at most one per user | only through the gateway (port `<base> + user id`) |
| `workspace-portal-firewall` (systemd) | the nftables table `inet workspace_portal`: what workspaces, SearXNG and the reader may reach. Docker won't start without it | |
| `portal-hostd` (systemd, each server) | hardware readings, daily energy and traffic; on the LLM server also engine updates | `127.0.0.1:9180`; `:9180` on the LLM server, open to the portal only |

Networks the gateway and compose create: `workspace-portal-ws` (Private, `172.29.0.0/16`, internal: no route
off the host), `workspace-portal-online` (Online, `172.28.0.0/16`, NAT to the public internet only), and one
small network each for SearXNG and the reader.

Data lives in `/srv/workspace-portal`: `db/portal.sqlite` (accounts, sessions, usage, audit log),
`users/<id>/private/` and `users/<id>/online/` (each workspace's home and files), `config/qwen/` (the model
list and Qwen Code settings) and `config/agent-versions.env` (the agent versions in use).

Check a running install:

```sh
sudo docker compose ps                      # web, gateway, searxng, reader: running (healthy)
sudo bash deploy/verify-isolation.sh        # ends with "failed 0"
curl -s http://127.0.0.1:8888/healthz       # OK
```

## 3. What can break on upgrades

Nothing upgrades by itself. The agents and the LLM engine move when the admin picks a version in **Admin >
Updates** (or runs `sudo bash deploy/update-image.sh <qwen|dsh> <version>`); everything else moves only when a pin
in this repository changes. An older version's image stays on the server, so going back is picking it again.

The portal changes the agents' own code at image build time and relies on some of their interfaces. Below is
everything an upgrade can break, and how it shows.

### Qwen Code

**Changes to the Web Shell's code** (`workspace-image/qwen/trim-web-shell.mjs`, applied when the image is
built). Qwen Code has no settings for these, so each one rewrites a piece of its minified bundle. Tested with
Qwen Code 0.27.0 and 0.27.4. When a new version no longer fits an edit, the image **still builds**, the build output says
`trim-web-shell: warning: <edit>: ...`, and that part works as Qwen Code ships it:

| Edit | What you see when it no longer fits |
|---|---|
| Web preview: the workspace's own addresses through the gateway | `http://localhost:3000` in the Web preview points at the user's own computer again and stays blank. The forwarding still works with the full address: `http://<server>:<preview port>/__portal/port/3000/`, where the preview port is the workspace's port + 1000 (Private `4100 + user id`, Online `4300 + user id`). |
| Web preview: pointer lock and dialogs in its frame | games in the preview can't capture the mouse, and `alert`/`confirm` do nothing. "Open externally" still works. |
| Plan mode on for new sessions | new sessions start without Plan mode: the agent acts at once, in the approval mode the composer shows. |
| sidebar: only Home, New session and the toggle | Live, Plugins, Channels, Scheduled Tasks, PR watches, Goals and the "More" menu come back where the stylesheet below doesn't reach, such as the phone drawer. |
| header: no Mobile access | nothing while the stylesheet still finds the button; else Mobile access comes back (it can't pair a phone through the portal). |

The image also gets a stylesheet that hides the rail's extra buttons, Activity and Mobile access, keyed on the Web
Shell's `data-*` attributes and icon names. A version that renames those brings the buttons back on desktop too.

**What the gateway relies on.** A change here shows as a workspace that doesn't start or work properly:

- `qwen serve` with `--hostname`, `--port`, `--workspace`, `--no-token-qr`, `--permission-response-timeout-ms` and
  the bearer token in `QWEN_SERVER_TOKEN` (`workspace-image/start-qwen.sh`): otherwise the workspace fails to
  start.
- `GET /health?deep=1` with `status`, `activePrompts`, `pendingPermissions`, `activeWork`, `channelAlive` and
  `idleSinceMs`; `GET /daemon/status` with `daemon.startup.preheat.status`. Without them the workspace never
  becomes ready, or the gateway can't see that the agent is working, and the idle timeout stops a workspace in
  the middle of a task.
- The system settings files at `QWEN_CODE_SYSTEM_SETTINGS_PATH` and `QWEN_CODE_SYSTEM_DEFAULTS_PATH`, and these
  keys: `modelProviders.openai` (with `capabilities.reasoning.efforts` and `defaultEffort`), `model.reasoningEffort`,
  `mcpServers`, `security.auth.enforcedType`/`selectedType`, `permissions.deny`, `tools.webSearch`,
  `general.enableAutoUpdate`, `privacy.usageStatisticsEnabled`, `telemetry.enabled`, `model.catalogRefresh`. A key
  Qwen Code renames is ignored without an error: models or the default reasoning effort stop applying, the search
  tools disappear, or an internet feature comes back on (it still can't reach the internet from Private).

### DeepSeek Harness

- **Lockdown** (`workspace-image/dsh/lockdown.patch.yml`): turns off dsh's DeepSeek account, web, plugin,
  feedback and telemetry features, and fixes its sandbox and approvals. The **build fails**, and the current version stays, when a row no longer exists in the new
  version or dsh rewords the warning the check reads. A row the new version dropped on purpose can be marked
  `# optional`. Plugins a new version adds are not locked down until the file lists them.
- **Agent presets** (`workspace-image/dsh/adapt-presets.mjs`): their web and plugin rows are switched off. The
  **build fails** when a preset no longer fits.
- **What the gateway relies on:** `dsh --profile web --patch ...`, its login cookie `dsh-auth-<hash>` and its
  signature (the gateway mints it), the Host and Origin `localhost:3080`, its API `session/list` (ready),
  `session/state` and `job/list` (working), and the one WebSocket `/api/remote.mux`. A change shows as a UI that won't load or sign in, a workspace that never becomes ready, or
  one the idle timeout stops mid-task.

### LLM engine (gufo)

- **The update** (`portal-hostd`): changes only `Image=` (and the version in `Documentation=`) of the gufo
  quadlet, waits for `/ready` to answer 200 and checks that `/props` reports the new version in `build_info`.
  A version that answers those differently is **rolled back** every time.
- **The release list** comes from the image registry's version tags and the release notes from the GitHub
  repository in `ENGINE_RELEASE_NOTES_REPO`.
- **Speeds in Admin > Usage**: the gateway reads the `timings` object at the end of each streamed answer
  (`prompt_n`, `prompt_ms`, `predicted_n`, `predicted_ms`, `cache_n`, as llama.cpp sends them). Without it the read
  and write speeds stay empty; answers still work.

### SearXNG

Pinned by the `FROM` line in `searxng/Dockerfile`; `searxng/settings.yml` beside it was tested with that release.
A newer release may drop or rename an engine (keenable, yahoo, yandex, metacrawler, and the fallbacks
duckduckgo, swisscows, privacywall, mojeek): searches then come back thin or empty. The gateway reads
`/search?format=json` (`results` with `url`, `title`, `content`, and `unresponsive_engines`). After moving the pin,
`verify-isolation.sh` checks that JSON is allowed and every fallback engine is loaded; then try a few searches
(not a load test: search engines block addresses that send many queries).

### Page reader

`reader/package.json` pins Defuddle (HTML to markdown) and `reader/requirements.txt` pins pypdfium2 (PDFs). A new
Defuddle can change what `read_page` returns: which part of a page counts as content, and how code blocks come
out. The tests in `reader/` cover both.

### Workspace tools (Chromium, Playwright MCP)

The Debian packages, Chromium among them, change only with `sudo bash deploy/update-image.sh --refresh`. The
agents' browser tool is Playwright MCP (`PLAYWRIGHT_MCP_VERSION` in `workspace-image/Dockerfile`) driving Debian's
Chromium at `/usr/bin/chromium`. A Chromium that version can't drive breaks only the browser tool.

### Host: Docker, kernel, firewall

The installer and the gateway refuse Docker older than 25.0.5 (internal networks could resolve internet names,
CVE-2024-29018). The firewall is an nftables table of its own, which rules from Docker, firewalld or Tailscale
can't reopen. After a Docker or kernel upgrade, run `sudo bash deploy/verify-isolation.sh`: it must end with
`failed 0`.

### The portal's own packages

Next.js, React and the other npm packages are pinned by `package-lock.json` and change only in this repository.
After changing them run `npm run typecheck && npm test && npm run build`.

### After any upgrade

1. The build output has no `trim-web-shell: warning`, and `sudo bash deploy/verify-isolation.sh` ends with
   `failed 0` (Admin > Updates doesn't run it: run it after an update there).
2. Start a workspace: the sidebar is trimmed, a new session has Plan on, the Web preview opens
   `http://localhost:3000` of an app running in the workspace, and a web search returns results.
3. If something broke, pick the previous version in Admin > Updates (its image is still there), or for the portal
   itself `git checkout <commit>` and run the installer again.
