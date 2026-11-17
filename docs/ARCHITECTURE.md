# Workspace Portal: architecture and contracts

This is the single source of truth for how the pieces fit together. Code must follow it. If
something here turns out to be wrong, fix this file in the same change.

## Components

```
Browser ──▶ :3000            web (Next.js)       sign-in, change password, admin, /workspace (top bar + iframe)
Browser ──▶ :3100+N          gateway agent port  user N's Private workspace: session check → HTTP/WebSocket proxy to wp-ws-N
Browser ──▶ :3300+N          gateway agent port  user N's Online workspace: the same, to wp-wo-N
                             gateway 127.0.0.1:4002   control API, called by web and the deploy scripts
                             gateway 172.29.0.1:4001  service API (LLM proxy + search/read MCP), called by Private workspaces only
                             gateway 172.28.0.1:4001  the same service API, called by Online workspaces only
                             searxng 127.0.0.1:8888   search engine, called by the gateway only (network "workspace-portal-searxng")
                             reader  127.0.0.1:4003   page reader, called by the gateway only (network "workspace-portal-reader")
                             portal-hostd 127.0.0.1:9180  this server's live readings (systemd service, not a container)
                             LLM server: portal-hostd :9180 (portal server's IP only)  its readings + LLM engine updates
                                    │ Docker API (/var/run/docker.sock)
              ┌─────────────────────┼─────────────────────┐
           wp-ws-1               wp-ws-2        …       wp-ws-N      Private (one agent each: qwen serve :4170 or dsh :3080, uid 200000+N)
              └── network "workspace-portal-ws" 172.29.0.0/16, bridge br-wportal, internal, ICC off ──┘
           wp-wo-1               wp-wo-2        …       wp-wo-N      Online (the same image and limits, uid 2000000000+N)
              └── network "workspace-portal-online" 172.28.0.0/16, bridge br-wonline, NAT, ICC off ──┘
                  (one container per user at a time: wp-ws-N or wp-wo-N, never both)
```

* `web` and `gateway` run with `network_mode: host` and share one SQLite file.
  * `web` runs as uid 10001 and can see only the `db/` directory.
  * `gateway` runs as root inside its container, with only CHOWN, DAC_OVERRIDE and FOWNER. It creates each
    user's directories, owned by that workspace's UID, and drives the Docker socket.
* Every user has two workspaces, **Private** and **Online** (`WorkspaceKind` = `private` | `online`), and at
  most one of them runs at a time. They share no mount, UID, network, socket or browser origin: their own
  folders (`users/<id>/private/`, `users/<id>/online/`), UID (`WORKSPACE_UID_BASE + id`, `ONLINE_UID_BASE + id`),
  container (`wp-ws-<id>`, `wp-wo-<id>`, label `workspace-portal.kind`), network, agent port range, browser
  token and service listener. The same image, hardening and limits otherwise; the agent's settings differ only
  in the service address.
* Private workspaces live on the `workspace-portal-ws` network.
  * Docker creates it `Internal` (no default route, no NAT, no DNS for outside names). ICC and IPv6 are off.
  * The host firewall (`deploy/firewall.sh`, nftables table `inet workspace_portal`, applied by
    `workspace-portal-firewall.service` before docker.service) admits only new connections to
    `172.29.0.1:SERVICE_PORT` from the bridge or subnet, and drops all forwarding from or to them. Its input
    chain runs at priority `filter - 10`, before firewalld's and Docker's chains; a drop there is final.
  * Docker requires the unit (a drop-in, `docker.service.d/workspace-portal-firewall.conf`: `Requires=` and
    `After=`): when `firewall.sh apply` fails, Docker and every container stay down. A restart of the unit
    therefore restarts Docker; `systemctl reload workspace-portal-firewall` swaps the rules atomically and is
    what the installer does. `uninstall.sh` removes the drop-in first.
  * Fence marker: the input chain's first rule rejects TCP to `127.0.0.1:SERVICE_PORT` on `lo` with
    `icmpx admin-prohibited`. Nothing listens there, so a connection fails with EHOSTUNREACH while the table
    is loaded and ECONNREFUSED without it. The gateway, which may not list the ruleset (no `NET_ADMIN`), asks it
    that way (`gateway/src/fence.ts`) at start, every 5 s and right before each Online container start. Unless
    the answer is EHOSTUNREACH ("unknown", a timeout or an odd error, counts as not loaded) the Online kind
    is off: `online` is `off` in WorkspaceInfo, starts get 409 `online_disabled` ("… the host firewall that
    keeps them off the local network is not loaded …"), and every Online workspace starting or running is
    stopped (stop reason `online_disabled`; the log says why). Private workspaces don't depend on it. It came
    with the Online chains, so a table from before them doesn't pass.
  * The gateway checks every attribute of an existing network with that name: driver bridge, internal, IPv6
    off, bridge name, ICC off, masquerade off, and exactly one IPAM pool with the configured subnet, gateway
    and IP range. A network that differs is replaced when no container uses it; otherwise the gateway refuses
    to start and lists the differences.
* Online workspaces live on the `workspace-portal-online` network (`ONLINE_NETWORK`, `ONLINE_SUBNET`
  172.28.0.0/16, gateway `ONLINE_GATEWAY_IP` 172.28.0.1, range `ONLINE_IP_RANGE`, bridge `ONLINE_BRIDGE`
  br-wonline): the public internet on any TCP port plus DNS, never the LAN, the host or another container.
  * Docker creates it as a NAT bridge: not internal, masquerade on, ICC off, IPv6 off; the gateway verifies
    it attribute by attribute like the Private one. Its containers get `Dns` = `ONLINE_DNS_1`, `ONLINE_DNS_2`
    (default 1.1.1.1, 9.9.9.9) and no search domains (`DnsSearch: ["."]`).
  * The firewall's chains for it, in the same table: `online_to_host` (input): replies, and new TCP to
    `ONLINE_GATEWAY_IP:SERVICE_PORT` only. `online_out` (forward): replies; IPv4 only; a drop for `@never`
    and one for `@not_public`, whatever the port; DNS (TCP/UDP 53) to the two resolvers; then new TCP to
    any port; then drop (no other UDP, no ICMP of its own). `online_in` (forward): replies only.
    * `not_public`: the IANA special-purpose ranges (the LAN, the host's other addresses, the Private network,
      the reader and SearXNG bridges and the Online subnet itself are all in it). The gateway refuses
      `ONLINE_DNS_*` in it, and the installer every `*_DNS_*` (the same list: `NOT_PUBLIC` in
      `gateway/src/config.ts`, kept equal to `firewall.sh not-public` by a test).
    * `never` (interval set, `auto-merge`): the four container subnets, plus `NEVER_REACH` in
      `/etc/workspace-portal/firewall.env`, which the installer works out at each run (`never_reach` in
      `deploy/lib.sh`): every network this host has a global address on, its default router, the IPv4
      addresses `LLM_UPSTREAM_URL`, `HOSTD_LLM_URL`, `HOSTD_PORTAL_URL`, `SEARXNG_URL` and `READER_URL` resolve to
      then, and `FIREWALL_NEVER_REACH`. So an LLM server or portal-hostd at a public address (a hosted API, a
      server with a public IP) is out of reach too. Names are resolved at install time: an address that
      changes later needs another install run (the installer warns about a name it can't resolve).
    With resolvers that are not host loopback addresses, Docker's embedded DNS (127.0.0.11) forwards from
    the container's own namespace, so its queries pass `online_out` like the container's.
  * `ONLINE_WORKSPACES=off` turns Online off for the whole portal: the gateway creates no Online network (one
    from before stays, unused), refuses Online starts (409 `online_disabled`), and stops an Online container
    it finds at start or later (stop reason `online_disabled`). The firewall chains stay loaded. The admin can
    also refuse Online per user (`users.online_allowed`, 403 `online_not_allowed`; a running Online workspace
    of such a user is stopped by the reaper, reason `online_not_allowed`).
* The LLM server is external; on the test server it is another machine on the LAN. Only the gateway talks to
  it.
* `portal-hostd` (`hostd/`, see `hostd/README.md`) is a small Python service, one per server, outside Docker.
  * It reports its host's live readings (CPU, GPU, memory and its bandwidth, power, fans) and samples only
    while a client streams them. On the LLM server it also updates the LLM engine (a rootless Podman quadlet)
    on the gateway's request. Bearer token (`HOSTD_PORTAL_TOKEN`, `HOSTD_LLM_TOKEN`); the gateway is its only
    client.
  * The portal server's binds 127.0.0.1 (`deploy/install.sh` installs it and generates its token). The LLM
    server's listens on its LAN address, opened in firewalld for the portal server's address only
    (`hostd/install.sh llm --portal <ip>` prints the two `.env` lines). Workspaces, the reader and SearXNG
    must not reach either (`verify-isolation.sh` checks).
* `searxng` is the search engine behind `web_search`: the upstream SearXNG image at the release pinned in
  `searxng/Dockerfile`, with `searxng/settings.yml` copied into the image.
  * It runs as uid 977 (the image's own user) with no capabilities, no volumes, a read-only root and one
    secret, `SEARXNG_SECRET` (the key SearXNG signs its cookies with; without one compose passes SearXNG's
    example key, which it refuses to start with). It is on the bridge network `workspace-portal-searxng`
    (`SEARXNG_SUBNET`, bridge `SEARXNG_BRIDGE`, ICC and IPv6 off), with its port published on
    `127.0.0.1:SEARXNG_PORT` for the gateway.
  * The upstream image declares `/etc/searxng` and `/var/cache/searxng` as volumes. Compose puts a tmpfs on
    each, so Docker creates no volume that would outlive the container and shadow a newer image. The settings
    are therefore at `/usr/local/etc/searxng/settings.yml`, named by `SEARXNG_SETTINGS_PATH`; the example
    settings the image's start script writes into the empty `/etc/searxng` are not read. SearXNG's caches
    are in the `/tmp` tmpfs and are rebuilt at every start, among them the ClearURLs tracker list, which it
    downloads then (`cdn.jsdelivr.net`, else `clearurls.xyz`) and uses to strip tracking parameters from
    result links.
  * `dns_search: ["."]` (here and on the reader) keeps the host's search domains out of the container, so a
    failed lookup does not send the LAN's name to the public resolvers.
  * The host firewall holds it exactly as it holds the reader (next item), with chains of its own:
    `searxng_to_host`, `searxng_out` (DNS to `SEARXNG_DNS_1`/`SEARXNG_DNS_2`) and `searxng_in`. The two
    containers are on separate bridges on purpose: the reader parses pages from anywhere, and SearXNG's
    results decide which pages an agent may open, so neither may reach or impersonate the other.
  * `SEARXNG_URL` names another instance for the gateway to use instead; the container then runs unused.
    The installer comments out a `SEARXNG_URL` that names the built-in's own address (the old
    `.env.example` set it), so the gateway follows `SEARXNG_PORT`.
  * Order in the installer: images, firewall, then the check that the loopback ports are free, then
    `SEARXNG_SECRET`, then `docker compose up`. Until the key exists compose passes SearXNG's example key
    and SearXNG exits, so it cannot run before its firewall chains exist; and an installer that stops at
    the port check has restarted nothing.
* `reader` is the one container that connects to addresses an agent named (see Page reader below).
  * It runs as uid 10002 with no capabilities, no volumes, a read-only root and no secrets, on the bridge
    network `workspace-portal-reader` (`READER_SUBNET`, bridge `READER_BRIDGE`, ICC and IPv6 off), with its
    port published on `127.0.0.1:READER_PORT` for the gateway.
  * The host firewall gives it three chains in the same table. `reader_to_host` (input): only replies to
    the gateway's connections. `reader_out` (forward): IPv4 only; a drop for every address in the sets
    `never` and `not_public` (see the Online network above); DNS to `READER_DNS_1`/`READER_DNS_2`; then TCP 80
    and 443; then drop. `reader_in` (forward): only replies. `deploy/firewall.sh` writes the same three
    chains for every entry of its `INTERNET_ONLY` list (the reader and SearXNG).

## Ports and env

All config comes from `.env` at the repo root (documented line by line in `.env.example`).
`docker-compose.yml` passes each service only the variables listed for it below, so web never sees the LLM or
SearXNG credentials, the gateway never sees `ADMIN_PASSWORD`, and `searxng` sees only `SEARXNG_SECRET`. An empty value means the default. The deploy
scripts read `.env` through `deploy/lib.sh` (`env_get`), falling back to `.env.example`.

| Var | Default | Used by | Meaning |
|---|---|---|---|
| `PORTAL_DATA_DIR` | `/srv/workspace-portal` | both | Host path; mounted at the same path inside the containers |
| `WEB_BIND` / `WEB_PORT` | `0.0.0.0` / `3000` | web | Portal UI |
| `AGENT_BIND` / `AGENT_PORT_BASE` / `AGENT_PORT_COUNT` | `0.0.0.0` / `3100` / `200` | gateway, web, installer | User N's Private workspace (1 ≤ N < count) is served on `base + N`. Web builds the iframe URL from it |
| `ONLINE_AGENT_PORT_BASE` | `AGENT_PORT_BASE + AGENT_PORT_COUNT` (3300) | gateway, web, installer | User N's Online workspace is served on `base + N`, the same count |
| `CONTROL_PORT` | `4002` | both, deploy scripts | Gateway control API on 127.0.0.1. The deploy scripts ask it whether a console update runs (`console_update_running` in `deploy/lib.sh`) |
| `SERVICE_PORT` | `4001` | gateway, firewall | Service API on `WORKSPACE_GATEWAY_IP` (Private) and `ONLINE_GATEWAY_IP` (Online) |
| `GATEWAY_CONTROL_SECRET` | random | both, deploy scripts | Bearer token of the control API; also the HMAC key of workspace browser tokens |
| `SESSION_COOKIE_SECURE`, `SESSION_TTL_HOURS` | `false`, `168` | web | Cookie `Secure` flag; sliding session lifetime |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_*_NAME` | | web | Seeds the single admin on first start if no admin exists, with `must_change_password` set |
| `LLM_UPSTREAM_URL` | `http://127.0.0.1:8080` | gateway | OpenAI-compatible server root; the proxy appends `/v1/...` |
| `LLM_API_KEY` | empty | gateway | Sent upstream as `Authorization: Bearer` if set |
| `LLM_MAX_CONCURRENCY` / `LLM_MAX_CONCURRENCY_PER_USER` | `3` / `2` | gateway | LLM queue limits |
| `SEARXNG_URL`, `SEARXNG_AUTHORIZATION`, `SEARXNG_TIMEOUT_SECONDS` | `http://127.0.0.1:SEARXNG_PORT`, empty, `20` | gateway | SearXNG backend of the search MCP: the stack's own unless `SEARXNG_URL` names another |
| `SEARXNG_PORT` | `8888` | compose | The built-in SearXNG's loopback port |
| `SEARXNG_SUBNET` / `SEARXNG_BRIDGE` | `172.30.250.16/28` / `br-wsearxng` | compose, firewall | The built-in SearXNG's network |
| `SEARXNG_DNS_1` / `SEARXNG_DNS_2` | `1.1.1.1` / `9.9.9.9` | compose, firewall | The built-in SearXNG's DNS servers; the only DNS the firewall lets it reach. Public addresses only (the installer refuses others) |
| `SEARXNG_SECRET` | generated by the installer | searxng | SearXNG's own cookie key |
| `SEARCH_MAX_CONCURRENT_PER_USER` | `2` | gateway | Concurrent searches per workspace |
| `SEARCH_FALLBACK_ENGINES` / `SEARCH_FALLBACK_BELOW` | `duckduckgo,swisscows,privacywall,mojeek` (`none`: no second try) / `3` | gateway | Engines asked by name, once, when a search returns fewer results than this |
| `SEARCH_CACHE_MINUTES` | `15` | gateway | How long an answer with results is reused for the same search (0 = off) |
| `READER_URL` | `http://127.0.0.1:READER_PORT` | gateway | The page reader; `off` removes the `read_page` tool |
| `READER_URL_POLICY` | `shown` | gateway | `shown`: a workspace opens only URLs it was shown, plus trusted hosts. `any`: every public page |
| `READER_TRUSTED_HOSTS` | `DEFAULT_TRUSTED_HOSTS` in `config.ts` | gateway | Sites open as a whole, subdomains included; `none` for no such site |
| `READER_PAGE_CHARS` / `READER_CACHE_MINUTES` | `20000` / `15` | gateway | Characters of a page per call; how long a page is kept for paging and repeat reads |
| `READER_TIMEOUT_SECONDS` / `READER_MAX_CONCURRENT_PER_USER` | `60` / `2` | gateway | How long the gateway waits for the reader; concurrent reads per workspace |
| `READER_FETCH_TIMEOUT_SECONDS` / `READER_MAX_CONCURRENT` | `20` / `2` | reader | Seconds per download; pages handled at once (more wait their turn) |
| `READER_MAX_DOWNLOAD_MB` / `READER_MAX_PDF_MB` / `READER_MAX_PDF_PAGES` | `5` / `15` / `60` | reader | Size limits, counted after decompression |
| `READER_USER_AGENT` | `Mozilla/5.0 (compatible; WorkspacePortalReader/1.0)` | reader | What the reader calls itself |
| `READER_PORT` / `READER_SUBNET` / `READER_BRIDGE` | `4003` / `172.30.250.0/28` / `br-wreader` | compose, firewall | The reader's loopback port and network |
| `READER_DNS_1` / `READER_DNS_2` | `1.1.1.1` / `9.9.9.9` | compose, firewall | The reader's DNS servers; the only DNS the firewall lets it reach. Public addresses only (the installer refuses others) |
| `WORKSPACE_AGENTS` | `qwen,dsh` | gateway, deploy scripts | The agents users pick from in Settings (`qwen` Qwen Code, `dsh` DeepSeek Harness), in display order. The first is the default for users who haven't picked one (and for a pick that is no longer enabled) |
| `QWEN_CODE_VERSION` / `DSH_VERSION` | `0.27.0` / `0.2.2-rc.1` | gateway, deploy scripts | The agents' default versions, what a fresh install builds. The current version (the admin's choice, in `config/agent-versions.env`; see Agent versions and updates) selects the per-user image `workspace-portal/workspace:qwen-<version>` / `:dsh-<version>`, built from the `qwen` / `dsh` target of `workspace-image/Dockerfile` |
| `WORKSPACE_IMAGE_CONTEXT` | `/app/workspace-image` | gateway | Build context of the agent updates: the project's `workspace-image/`, which `docker-compose.yml` mounts read-only there, so edits apply to the next console build. Not passed by `docker-compose.yml`: by default the gateway finds `workspace-image/` next to its code, in the container and in a development checkout alike. Set it only for another layout |
| `WORKSPACE_NETWORK` / `_SUBNET` / `_GATEWAY_IP` / `_IP_RANGE` / `_BRIDGE` | `workspace-portal-ws` / `172.29.0.0/16` / `172.29.0.1` / `172.29.128.0/17` / `br-wportal` | gateway, firewall | The Private network; the gateway creates it at startup |
| `WORKSPACE_UID_BASE` | `200000` | gateway, installer | User N's Private workspace runs as uid/gid `base + N` |
| `ONLINE_WORKSPACES` | `on` | gateway, installer | `off`: no Online workspace starts on this portal (and the gateway creates no Online network) |
| `ONLINE_NETWORK` / `_SUBNET` / `_GATEWAY_IP` / `_IP_RANGE` / `_BRIDGE` | `workspace-portal-online` / `172.28.0.0/16` / `172.28.0.1` / `172.28.128.0/17` / `br-wonline` | gateway, firewall | The Online network; the gateway creates it at startup while Online is on |
| `ONLINE_DNS_1` / `ONLINE_DNS_2` | `1.1.1.1` / `9.9.9.9` | gateway, firewall | The Online containers' DNS servers; the only DNS the firewall lets them reach over UDP. Public addresses only (gateway and installer refuse others) |
| `ONLINE_UID_BASE` | `2000000000` | gateway, installer | User N's Online workspace runs as uid/gid `base + N`; `base + AGENT_PORT_COUNT` below 2147352576 (systemd's foreign UID range), as for `WORKSPACE_UID_BASE` |
| `FIREWALL_NEVER_REACH` | empty | installer, firewall | Addresses or CIDRs the Online workspaces, the reader and SearXNG must never reach even when public, on top of what the installer finds itself (see the Online network) |
| `WORKSPACE_MEMORY` / `_CPUS` / `_PIDS` / `_SHM` / `_TMP` | `3g` / `4` / `1024` / `1g` / `1g` | gateway | Per-container limits (both kinds); `_TMP` sizes the tmpfs `/tmp` |
| `WORKSPACE_BROWSER` | `true` | gateway | Adds the Playwright MCP server (headless Chromium in the workspace) |
| `DEFAULT_REASONING_EFFORT` | `low` | gateway | The reasoning effort every new agent session starts with (`none` … `max`, for the models that offer it); `model` keeps each model's own default. See Agent settings rendering |
| `HOSTD_PORTAL_URL` / `HOSTD_PORTAL_TOKEN` | `http://127.0.0.1:9180` / generated by the installer | gateway, installer | This server's portal-hostd. No token or `off`: not set up |
| `HOSTD_LLM_URL` / `HOSTD_LLM_TOKEN` | empty | gateway | The LLM server's portal-hostd (readings and engine updates); both printed by `hostd/install.sh llm`. Empty: not set up |
| `ENGINE_RELEASE_NOTES_REPO` | `gufo-org/gufo` | gateway | GitHub repository whose releases are the engine's release notes in Admin > Updates; `none` for none |
| `ENGINE_DRAIN_MINUTES` | `15` | gateway | How long an engine update waits for running LLM requests before it restarts the engine anyway |
| `MAX_RUNNING_WORKSPACES` | `4` | gateway | Running-container cap |
| `IDLE_TIMEOUT_MINUTES` | `30` | both | Idle stop; also the approval timeout of `qwen serve` (dsh has none: see Busy and idle) |
| `MAX_BUSY_HOURS` | `24` | gateway | Work stops counting as activity this long after a person last used the workspace (0 = never) |
| `UPLOAD_LIMIT_MB` | `100` | gateway | Max request body through the agent proxy |
| `FIREWALL_ALLOW_SOURCE` | detected | installer | Sources allowed to reach `WEB_PORT` and both kinds' agent ports in firewalld/ufw: default the LAN of the default route, plus `100.64.0.0/10` when `tailscale0` exists |
| `TZ` | the host's zone, recorded by the installer (empty: UTC) | both, installer | Time zone of the local days: usage today, the energy meter's daily totals |

Config validation: each kind's agent port range must end below 65536, the two must not overlap (a port says
user and kind), and `WEB_PORT`, `CONTROL_PORT` and `SERVICE_PORT` must lie outside both. The two UID ranges
(`base + 1` … `base + AGENT_PORT_COUNT - 1`) must not overlap and must end below 2147352576; the networks,
bridges and subnets must differ; each gateway IP and IP range must lie in its subnet; `ONLINE_DNS_*` must be
public (outside `NOT_PUBLIC`). The Online settings are checked even with `ONLINE_WORKSPACES=off`, so turning it
on later cannot break isolation. The installer checks the port and UID ranges, the addresses, every `*_DNS_*`
(public, and outside `never`) and the switch too, before it restarts anything; it also refuses UID ranges that
overlap an `/etc/subuid` or `/etc/subgid` range. Only user ids 1 … `AGENT_PORT_COUNT - 1` have workspace ports
(and UIDs clear of the other kind's): a start for any other id is 409 `no_workspace_port`, and reconcile doesn't
adopt such a container (it removes it). A portal-hostd token must be at least
32 characters without spaces, and needs its URL.

## Data directory

```
PORTAL_DATA_DIR/                      root 0755
  db/portal.sqlite (+ -wal, -shm)     10001 (web); the gateway hands files it creates to the dir's owner
  config/                             root 0700
    qwen/                             root 0700 (files 0600): the admin's settings.json, system-defaults.json
    agent-versions.env                root 0600: the current agent versions (QWEN_CODE_VERSION=0.27.4); written
                                        by the gateway after an update and by deploy/update-image.sh
  users/<id>/                         root 0711, nothing but the two kinds' folders
    private/                          root 0711: the Private workspace (uid = WORKSPACE_UID_BASE + id, 200000+id)
      home/                           uid 0700  → /home/user, shared by both agents:
                                        ~/.qwen (Qwen Code: chats, memory, user settings),
                                        ~/.dsh and ~/.agents (DeepSeek Harness: sessions, settings, skills), caches
      workspace/                      uid 0700  → /workspace, shared by both agents
      system/                         root 0755, rewritten at every start, mounted read-only:
        qwen/settings.json, qwen/system-defaults.json   → /etc/workspace-portal/qwen/   (Qwen Code starts)
        dsh/portal.patch.yml                             → /etc/workspace-portal/dsh/    (DeepSeek Harness starts)
        passwd, group                                    → /etc/passwd, /etc/group
    online/                           root 0711: the Online workspace, the same layout (uid = ONLINE_UID_BASE + id,
                                        2000000000+id; its settings name the Online service address)
```

A container mounts only its own kind's folder; neither kind's container can see the other's files.
`verify-isolation.sh` checks these owners and modes on a live install.

Before kinds existed the Private files were `users/<id>/{home,workspace,system}`. The gateway moves them
into `private/` (renames on the same filesystem: owners, modes and SELinux labels stay; the old `system/` is
removed, it is rendered again at every start) only while that user has no container: at gateway start for
every user without one, and at a user's next start (after any leftover container is removed) for a user whose
container from before still ran and was adopted. Each step can be repeated, so an interrupted move finishes the
next time. A `private/home` or `private/workspace` that already holds files stops the move with an error naming
both folders (nothing is overwritten; that start fails until an admin merges them).

The installer labels the tree `container_file_t` (SELinux), so binds need no `:z`.

## Database (packages/db)

Schema: `packages/db/src/schema.ts` (Drizzle) plus `migrations.ts` (SQL, applied with `PRAGMA user_version`).
Open it only through `getDatabase(PORTAL_DATA_DIR + "/db/portal.sqlite")`. Both services call it at startup,
and migrations are safe to run concurrently.

`workspaces.agent` (migration 2) is the agent of the current or last run (`qwen` | `dsh`, null before the
first start). A container started before agents existed has no agent label and counts as `qwen`.

`users.agent` (migration 3) is the agent the user picked in Settings (`qwen` | `dsh`); null = the
install's default, the first of `WORKSPACE_AGENTS`.

`users.online_allowed` (migration 5, default 1) is the admin's per-user permission for an Online workspace.
`workspaces.kind` (migration 5, `private` | `online`, default `private`) is the kind of the current or last
container; rows from before kinds are Private, and so is a container without a kind label.

Migration 6 replaces the hand-kept `energy_rates` with published prices: `energy_prices` (one row per place and
period: `location` such as `US-FL` or `EU-DE`, `period_start`/`period_end` (end exclusive), `period` as the source
names it (`2026-08`, `2026-S1`), `price` per kWh, `currency` `USD` | `EUR`, `source` `eia` | `eurostat`,
`fetched_at`) and `portal_settings` (key/value; `energy_price_location`, unset until the admin picks a place).
The places and their sources are `packages/db/src/energy-locations.ts`, which imports nothing, so the web app's
client components load it on its own (`@portal/db/energy-locations`); the package's main entry brings SQLite.

Migration 7 adds `workspace_sessions`, one row per run of a user's workspace, from Start to its stop (`user_id`,
`kind`, `agent`, `started_at`, `ended_at` null while it runs: at most one open row per user), with what its LLM
requests added up to: `requests` and `failed`, `prompt_tokens` (cached ones included), `output_tokens`,
`cached_tokens`, `read_tokens`/`read_ms` and `write_tokens`/`write_ms` (the engine's own `timings`; Read and
Write are their quotients), `llm_ms` (forwarded to finished), and `energy_j`/`energy_ms` (its share of the LLM
server's measured energy, null until there is any, and the measured time it had a request running: its average
draw is their quotient). See Workspace sessions.

Ownership:
* web writes `users`, `sessions`, `login_attempts`, `portal_settings`, and `audit_log` (user and admin actions,
  among them `agent_preference_changed` with `{ from, to }`, agent kinds or null for the default,
  `user_online_access_changed` with `{ allowed }`, and `energy_price_location_set` with
  `{ location: { from, to } }`, the places by name ("Florida, US"); older logs may hold `energy_rate_set` from the hand-kept rates).
* gateway writes `workspaces`, `llm_usage`, `workspace_sessions` (Workspace sessions), `host_daily` and
  `host_meter` (the energy meter), `energy_prices` (Electricity prices), and
  `audit_log` (`workspace_started` with `{ agent, version, kind }`, `workspace_stopped` with `{ reason, kind }`,
  `workspace_error` with `{ error, kind }` (plus `reason` when a stop failed), `workspace_files_erased` with
  `{ kind }` and the admin as actor, `agent_updated` with `{ agent, from, to, rebuild }`,
  `agent_update_failed` with `{ agent, version, error }`, error "Cancelled" for a cancellation,
  `engine_updated` with `{ from, to }`, `engine_update_failed` with `{ from, to, error, rolledBack }`; entries
  written before the rollback route went also have `kind: "update" | "rollback"`). The audit `actorUserId` is
  the one given to `/stop` or `/update`; otherwise it is null. Web writes `agent_image_removed` (`{ agent, version }`) and
  `engine_image_removed` (`{ version, digest }`) after the gateway removed an image.
* gateway only reads `users` and `sessions` (`loadSessionContext`, `countSessionsUsingWorkspace`).

## Sessions and cookies

* Cookie `portal_session` holds a random token. The DB stores `hashSessionToken(token)` as `sessions.id`.
* Attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>`, plus `Secure` when `SESSION_COOKIE_SECURE=true`.
  There is no `Domain` attribute.
  * Cookies ignore ports, so the gateway's agent ports receive it.
  * The page on :3000 and the iframe on :3100+N (or :3300+N) are same-site, so the cookie is sent inside the
    iframe.
* Sliding expiry: web bumps `last_seen_at`/`expires_at` at most once per 10 minutes.
* `loadSessionContext(db, hash)` returns `{session, user, target, actingAs}`. `target` is the user, or for an
  admin, `acting_as_user_id` if set. **A session can use exactly one workspace: `target.id`'s.**

## Agent credentials and browser auth

Every container start gets a fresh random credential (`driver.generateCredential`), passed in the
container's env (`driver.credentialEnv`). It never reaches a browser; the gateway reads it back from the
container's config when it adopts a running workspace. How the browser is authorised differs per agent
(`driver.browserAuth`); the session, port and Origin checks of the agent ports apply to both.

### Qwen Code: workspace browser token (`browserAuth: "token"`)

`qwen serve` authenticates every API call and WebSocket with `Authorization: Bearer <QWEN_SERVER_TOKEN>`.
That token is random per container start and never leaves the gateway and the container. The browser
gets a different one:

```
agentBrowserToken(GATEWAY_CONTROL_SECRET, sessions.id, target.id, kind)
  = base64url(HMAC-SHA256(secret, "workspace-portal/agent-token/v2\n" + sessionId + "\n" + userId + "\n" + kind))
```

* web puts it in the iframe URL fragment: `http://<host>:<base+N>/?theme=dark#token=<t>` (`base` the kind's:
  `AGENT_PORT_BASE` or `ONLINE_AGENT_PORT_BASE`). The Web Shell moves it to `sessionStorage`. A fragment is
  never sent to a server and doesn't appear in referrers.
* The gateway recomputes it for the request's session and the port's user and kind, and compares in constant
  time. A user's Private token is no good on their Online port, and the other way round.
  * A match: the gateway swaps in the container's real token.
  * A mismatch: 401.
  * No Authorization header: forwarded without one, so only the unauthenticated static assets work.
* The token is useless without the session cookie, and it stops working when the session ends or the
  admin switches workspaces (new target).

### DeepSeek Harness: minted cookie (`browserAuth: "cookie"`)

dsh's web UI authenticates with a browser-session cookie it signs with a secret from its credentials store.
The credential is that secret, `DSH_COOKIE_SECRET` (32 random bytes, base64url). `start-dsh` writes it to
`/tmp/dsh-credentials.yaml` (mode 0600, fresh tmpfs, which the image's lockdown patch names as the
credentials file) and unsets it before it execs tini and dsh, so no process in the container has it in its
environment; only `docker exec` shells, which get the container's configured env, would.

* The browser never holds a dsh cookie. For every request it forwards, the gateway mints one
  (`gateway/src/agents/dsh.ts`, `mintDshCookie`):
  `dsh-auth-<b64url(sha256("localhost:3080"))>=v1.<b64url(JSON {version:1, authority, issuedAt, expiresAt})>.<b64url(HMAC-SHA256(secret, body))>`,
  valid for 10 minutes and issued a minute in the past.
* dsh binds cookies to the Host they were issued for and checks Origin against Host. The gateway always
  sends `Host: localhost:3080` and, when the browser sent an Origin (already checked to be the workspace's
  own), `Origin: http://localhost:3080`. The browser's own cookies and `Sec-Fetch-*` headers are dropped
  and `Set-Cookie` is stripped from responses, as for Qwen Code.
* So a dsh request is authorised by the portal session, the port's user and the Origin check alone. The
  iframe URL is `http://<host>:<base+N>/`, with no token.

## Gateway control API (127.0.0.1:CONTROL_PORT)

Every request needs `Authorization: Bearer ${GATEWAY_CONTROL_SECRET}`. JSON in and out.
Errors: `{ "error": "<code>", "message": "<human text>" }` with a 4xx/5xx status.

```
GET  /control/health                         → { ok: true }
GET  /control/stats                          → HostStats
GET  /control/live                           → text/event-stream: the admin's live view (see Live view)
GET  /control/energy-prices                  → EnergyPriceStatus   each source's last download (see Electricity prices)
POST /control/energy-prices/refresh          → EnergyPriceStatus   download both now (a source fetched in the last 10 min is skipped); answers when done
GET  /control/agents                         → { agents: AgentInfo[] }   (the enabled agents, in WORKSPACE_AGENTS order; version = the current one)
GET  /control/agents/versions[?refresh=1]    → AgentVersionsOverview   (refresh=1 asks the npm registry and GitHub again)
POST /control/agents/:agent/update           → AgentUpdateJob  body { version: "0.27.4", rebuild?: boolean, actorUserId?: number }; see Agent versions and updates
POST /control/agents/update/cancel           → { cancelled: boolean }  (false: no job, or too late to cancel)
DELETE /control/agents/:agent/images/:version → { ok: true }
GET  /control/engine[?refresh=1]             → EngineOverview   (refresh=1 asks the registry and GitHub again); see LLM engine updates
POST /control/engine/update                  → EngineUpdateJob  body { version: "X.Y.Z", actorUserId?: number }
GET  /control/updates/running               → { running, agent, engine: boolean }  an agent build or an engine update is under way (answers at once; for the deploy scripts)
POST /control/engine/cancel                  → { cancelled: boolean }  (only while downloading or draining)
POST /control/engine/restart-now             → { ok: boolean }  ends the drain: restart even though requests still run
DELETE /control/engine/images/:digest        → { ok: true }
GET  /control/workspaces                     → { workspaces: WorkspaceInfo[] }   (every user that has a row)
GET  /control/workspaces/:userId             → WorkspaceInfo (status "stopped" if no row)
POST /control/workspaces/:userId/start       → WorkspaceInfo   body { agent?: AgentKind, kind?: WorkspaceKind } (or none: the user's agent; attach, else Private); see below
POST /control/workspaces/:userId/stop        → WorkspaceInfo   body { reason?: "admin" | "user" | "deactivated" | "deleted" (default "admin"), actorUserId?: number }; immediate, even while working
POST /control/workspaces/:userId/attach      → WorkspaceInfo   a session started using it: a starting or running workspace's pending stop is off; never starts one
POST /control/workspaces/:userId/release     → WorkspaceInfo   no session uses it any more: stop now, or once the agent's work is done (stopPending)
POST /control/sessions/:sessionId/disconnect → { closed: number }  closes that session's open agent connections and presence
DELETE /control/workspaces/:userId/files?kind=private|online → { ok: true }  body { actorUserId?: number }; empties that kind's home and workspace (Admin's "Erase … files"); 409 workspace_running while that kind starts, runs or stops, or while Docker still has a container of that kind for the user (a leftover is removed first; one that can't be is this 409). A start of the other kind meanwhile waits for it before it touches any file
DELETE /control/workspaces/:userId/data      → { ok: true }    stops the container and deletes the user's data directory (both kinds); 500 {error:"stop_failed"} (nothing deleted) if the container can't be removed
```

**One kind at a time.** A user has a Private and an Online workspace; one container at a time, chosen at
start. The web app always names the kind the user chose and confirmed; nothing else starts one (see Agent
ports):

* `kind` given: that kind starts (or, already starting or running, is attached to). The other kind starting
  or running is 409 `kind_mismatch` ("Your Online workspace is running. Stop it to start the Private one.").
* No `kind` (older callers): attach to whichever kind is starting or running, else start Private.
* Online only while `ONLINE_WORKSPACES` is on and the host firewall's fence answers (else 409
  `online_disabled`; see the fence marker above), and the admin allows it for the user
  (`users.online_allowed`, else 403 `online_not_allowed`). Checked only when an Online container would be
  created, the fence once more right before the container starts (gone by then: `done` rejects with 409
  `online_disabled`, the workspace is stopped with that reason); one that runs when the permission goes is
  stopped by the reaper (stop reason `online_not_allowed`), one found running while Online is off or the fence
  is missing is stopped at gateway start, by the fence check or by the reaper (`online_disabled`).
* 409 `no_workspace_port`: the user's id is outside 1 … `AGENT_PORT_COUNT - 1` (no port serves it, and its UIDs
  could be the other kind's). Either kind.
* 400 `unknown_kind`: `kind` (in the body, or the files route's query) is not `private` or `online`. 409
  `deleting` also covers a start of a kind whose files are being erased ("The Online workspace's files are
  being erased.").
* Erasing a kind's files needs that kind stopped, and no container of that kind (or of a kind Docker's label
  doesn't tell) left for the user in Docker: a leftover of a failed stop is removed first, whichever kind the
  workspace shows now; one that can't be removed is 409 `workspace_running`. The other kind may run (they share
  nothing); one starting meanwhile waits for the erase before it prepares its files (Private's erase takes the
  files from before kinds, which that start would otherwise move into `private/`). The gateway audits
  `workspace_files_erased` `{ kind }` with `actorUserId`. Private also loses files still in the layout
  from before kinds. Capacity rules are unchanged: a user has at most one container.

**One agent at a time.** A workspace runs one agent (one container), chosen when it starts:

* Stopped or error: start `agent`; without one (the web app never names one), the user's agent from
  Settings (`users.agent`) when it is enabled, else the first of `WORKSPACE_AGENTS`.
* Starting or running: with the same agent or none named, its state is returned and `stopPending`
  cleared. Naming the other agent is 409 `agent_mismatch` ("<name> is already running in this workspace.
  Stop it to switch."). A new pick in Settings applies at the next start.
* 400 `unknown_agent` (not an agent kind), 400 `agent_unavailable` (an agent named that is not in
  `WORKSPACE_AGENTS`), 409 `capacity` (the cap is reached and nothing can be evicted), 409 `deleting`
  (its data is being deleted).

Start returns as soon as the container is created and started (`status: "starting"`, `ready: false`).
The agent boots in the background (up to 90 s). The caller polls `GET /control/workspaces/:userId` until
it sees `status: "running"` with `ready: true`, or `status: "error"` with `lastError`.

Agent update errors: 400 `unknown_agent`, `agent_unavailable` (not in `WORKSPACE_AGENTS`), `invalid_version`
(not an exact version: dist-tags like `latest` are not taken), `invalid_actor`, `bad_request`; 404
`version_not_found` (not published on npm); 409 `update_running` (one job at a time, for all agents, and the
next one only once the last has cleaned up); 502 `registry_unreachable` (also a registry that stops answering
mid-body). Image removal errors: 400 `unknown_agent`, `invalid_version`; 404 `not_found`; 409
`image_current` (the current version's image), `image_in_use` (a container uses it), `update_running` (a job
is updating that agent).

Engine errors: 400 `invalid_version` (not X.Y.Z), `invalid_digest`, `invalid_actor`; 404
`version_not_found` (the registry has no such tag, and the LLM server no image of it), `not_found` (no such
local image); 409 `already_current`, `engine_job_running` (one job at a time), `image_current`, `not_pulled`
and `job_running` (portal-hostd's own refusals: an image removed meanwhile, a job of its own); 429 `too_many_viewers` (the live view, 8 at once); 502
`hostd_failed`; 503 `engine_unavailable` (no portal-hostd for the LLM server, it can't be reached, or it
controls no engine).

Other error codes:
* 400: `invalid_user_id`, `invalid_reason`, `invalid_actor`, `invalid_json`, `bad_request`,
  `unknown_agent`, `agent_unavailable`, `unknown_kind`, `invalid_version`, `invalid_digest`.
* 403: `online_not_allowed`.
* 404: `user_not_found`, `not_found`, `version_not_found`.
* 405: `method_not_allowed`.
* 401: `unauthorized`.
* 409: `capacity`, `deleting`, `agent_mismatch`, `kind_mismatch`, `online_disabled`, `no_workspace_port`, `workspace_running`,
  `update_running`, `image_current`, `image_in_use`,
  `already_current`, `not_pulled`, `engine_job_running`, `job_running`.
* 429: `too_many_viewers`.
* 500: `start_failed`, `stop_failed`, `internal`.
* 502: `registry_unreachable`, `hostd_failed`.
* 503: `engine_unavailable`.

```ts
type AgentKind = "qwen" | "dsh";   // @portal/db AGENT_KINDS; display names in AGENT_NAMES
type WorkspaceKind = "private" | "online";   // @portal/db WORKSPACE_KINDS; display names in WORKSPACE_KIND_NAMES
type AgentInfo = { id: AgentKind; name: string; description: string; version: string };
type WorkspaceInfo = {
  userId: number;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  agent: AgentKind | null;     // the agent of the container; when stopped, the one it ran last; null if never started
  kind: WorkspaceKind;         // the kind of the container; when stopped, the last one; "private" if never started
  online: "allowed" | "off" | "not_allowed";  // may this user start Online: ONLINE_WORKSPACES off or the host firewall not loaded → "off", the admin's no → "not_allowed"
  agentVersion: string | null; // the agent version of the starting/running container's image; null when stopped or unknown
  ready: boolean;              // the agent answered its readiness probe (see "Agents")
  startedAt: number | null;
  lastActivityAt: number | null;
  idleSeconds: number | null;  // null when not running; 0 while busy
  memoryBytes: number | null;
  connections: { owner: number; admin: number };  // sessions that have it open (streams, sockets, or a request in the last 20 s)
  llmInFlight: number;
  busy: boolean;               // the agent is working; never idle-stopped
  busyReason: "task" | "llm" | "cpu" | null;
  stopPending: boolean;        // nobody is signed in to it any more; it stops once the work is done
  stopReason: string | null;   // "logout" | "idle" | "admin" | "user" | "deactivated" | "deleted" | "capacity" | "error"
                               // | "online_disabled" | "online_not_allowed" | ...
  lastError: string | null;
};
type HostStats = {
  running: number; maxRunning: number; idleTimeoutMinutes: number;
  memTotalBytes: number; memAvailableBytes: number; cpus: number;   // this server, from the gateway's /proc
  llm: { inFlight: number; queued: number; maxConcurrency: number };
};
type AgentVersionsOverview = {
  agents: AgentVersionInfo[];      // the enabled agents, WORKSPACE_AGENTS order
  job: AgentUpdateJob | null;      // the running job, else the last finished one since the gateway started
  registryError: string | null;    // the last registry query failed (releases/latest unknown or stale)
  checkedAt: number | null;        // epoch ms of the last successful registry query
};
type AgentVersionInfo = {
  id: AgentKind; name: string;
  packageName: string;             // "@qwen-code/qwen-code" | "@deepseek-ai/dsh"
  current: string;                 // new workspaces start with this version
  defaultVersion: string;          // from .env
  latest: string | null;           // dist-tags.latest; null when unknown
  updateAvailable: boolean;        // latest is newer than current (semver precedence, prereleases included)
  releases: AgentRelease[];        // the Package images table's versions, newest first (see Releases below)
  installed: InstalledImage[];     // this agent's workspace images in Docker, newest version first
  running: Array<{ version: string | null; count: number }>;  // starting/running workspaces by image version
};
type AgentRelease = {
  version: string;
  publishedAt: number | null;      // epoch ms npm published it (the packument's `time`); null when unknown
  latest: boolean;                 // dist-tags.latest names it
  notes: ReleaseNotes | null;      // its GitHub release; null when there is none
};
type ReleaseNotes = { title: string; url: string /* the release on github.com */; publishedAt: number | null; body: string /* markdown, cut at 12,000 characters */; breaking: boolean };
type InstalledImage = { version: string; image: string; sizeBytes: number; createdAt: number; current: boolean; inUse: number };
type AgentUpdateJob = {
  id: string; agent: AgentKind;
  fromVersion: string;             // the current version when the job started
  version: string;                 // the target version
  rebuild: boolean;
  reuse: boolean;                  // uses the image already on the server: no build, only the check (starts in "verifying")
  actorUserId: number | null;
  phase: "building" | "verifying" | "succeeded" | "failed" | "cancelled";
  step: string | null;             // the current build step, e.g. "[dsh 3/6] RUN npm install -g ..."
  log: string[];                   // the last 200 lines of build output
  startedAt: number; finishedAt: number | null; error: string | null;
};
```

## Agent versions and updates

Each agent has a **default version** (`QWEN_CODE_VERSION` / `DSH_VERSION` in `.env`, what a fresh install
builds; the gateway never changes it) and a **current version**, what new workspaces of that agent start
with: `PORTAL_DATA_DIR/config/agent-versions.env` (KEY=VALUE lines with the `.env` keys), else the default.
`agent-versions.ts` reads the file at boot, keeps it in memory and is the only source of the current
version and image for the gateway; it writes the file (temp file + rename, mode 0600) after a successful
update. `deploy/update-image.sh` writes it too (`agent_version_set` in `deploy/lib.sh`) and then restarts the
gateway; `deploy/lib.sh agent_version` reads it (then `.env`, then `.env.example`), so `install.sh`,
`verify-isolation.sh` and `update-image.sh` act on the current version. An invalid value counts as missing.
Both writers re-read the file and change only their own agent's line (other lines stay as they are), so
neither undoes what the other just wrote; `update-image.sh` also refuses to save a version or restart the
gateway while a console job runs (it asks the control API right before each), and `install.sh` refuses to
start while one runs.

**Releases** (`npm-registry.ts`, `github-releases.ts`, `release-cache.ts`, `agent-overview.ts`):

* The npm registry's full document of each agent's package (`AgentDriver.release.packageName`): its
  dist-tags, every version with its publish time (`time`, which only the full document has) and deprecation,
  and its `repository`. Qwen Code's is about 1.9 MB of JSON, some 230 kB gzipped; the gateway keeps only
  those fields, and asks again with the last answer's ETag, so while nothing was published the registry
  answers 304 without a body. Cached 10 minutes (`?refresh=1` asks at once; a failed query is retried after
  a minute, and the last answer stays, marked by `registryError`). 10 s per request, at most 32 MiB.
* Release notes: the newest 100 GitHub releases (`GET /repos/{owner}/{name}/releases?per_page=100`, anonymous, 60
  requests an hour) of the repository the package's `repository` field names, asked again when the package
  changed, on `?refresh=1`, else hourly; a GitHub failure keeps the last notes and is only logged. A release
  belongs to a version by its tag (`v0.27.4`, `0.27.4`, or the package's own prefix, `dsh-v0.2.2-rc.1`), so
  another product's tags in the same repository (`desktop-v…`, `sdk-typescript-v…`) are left out, and its
  page is the URL GitHub gives: no release, no notes and no link. `breaking` only for real evidence: a
  breaking-changes heading followed by something other than "none" (Qwen Code's "No known breaking changes."
  is none), a `BREAKING CHANGE:`/`Breaking change:` line, or a Conventional Commits `type!:` entry.
* Offered (`offeredReleases`, the Package images table): the 5 newest stable releases, plus the current
  version and every version with an image here, newest first. Stable: no prerelease and not deprecated,
  and no newer than `latest` (a release published but not yet made latest isn't offered); `latest` itself
  always counts, even a prerelease (DeepSeek Harness's latest is `0.2.2-rc.1`). A package whose latest is a
  prerelease (DeepSeek Harness publishes release candidates only) is filled up to 5 with the newest
  prerelease of the same kind (`rc`) of each earlier version line (`0.2.1-rc.5`, `0.2.0-rc.2`, …), so it offers
  earlier versions too; nightlies and previews never fill a list.

Versions compare by semver precedence (`versions.ts`).

**An update** (`agent-updater.ts`, one job at a time for all agents):

1. The request is checked before the job starts: it names an exact version (the one the admin confirmed;
   never a dist-tag, which a fresher registry answer could move). If `workspace-portal/workspace:<agent>-<version>`
   exists and `rebuild` is false, the job uses that image as it is: no registry check, no build (step 3
   directly, the job starts in `verifying` with `reuse: true` and "Using the image already on this server" in
   its log), so going back works without npm. Otherwise the version must be published (404 otherwise),
   and the job clears leftovers of interrupted jobs before it builds (sweep, see Boot): in the job, so the
   request answers at once.
2. Build: the Docker Engine API with BuildKit (`version: "2"`; the legacy builder can't do `COPY --chmod`),
   context `WORKSPACE_IMAGE_CONTEXT` streamed as a tar, `target: <agent>`, build argument
   `<versionKey>=<version>`, `pull: true`, `nocache` when `rebuild`. With the cache a known version takes
   seconds. The result is tagged `workspace-portal/workspace-build:<agent>-<version>` (staging), so a failed
   rebuild of the current version never touches the image workspaces use. Progress arrives as BuildKit
   status protobufs (`buildkit-status.ts`, `protobuf.ts`), rendered like `docker build --progress=plain`
   (`build-progress.ts`) into `step` and `log`; a progress message that can't be decoded adds one warning
   line and the build goes on. The build and the version check (step 3) have 30 minutes together; a cancel
   or the time limit aborts the request, and closing the connection makes the engine cancel the build. The
   build's BuildKit session (a hijacked `/session` connection with a gRPC server in the gateway) is opened by
   the builder itself with dockerode's session code and closed however the build ends (dockerode's
   `buildImage` closes it only when the stream ends normally).
3. Verify: `<cli> --version` in a throwaway container of the staging image, or of the existing image
   (no network, read-only root, no capabilities, uid 65534, 45 s), must report exactly that version.
4. Promote (from here on the job can no longer be cancelled): a new build's staging image is tagged
   `workspace-portal/workspace:<agent>-<version>`, the version becomes current and is saved, the job succeeds
   and `agent_updated` is audited. Only then does a rebuild remove the build it replaced, best effort: that
   build stays while a container uses it or a tag still names it, or if the gateway stops first, and a later
   sweep removes it once it is untagged and unused.

A failed or cancelled job audits `agent_update_failed`, then removes its staging tag (an existing image it
only checked stays), and leaves the current version and its image as they were. Until that removal is done,
a new request gets 409 `update_running` ("The last update is still cleaning up"). Running workspaces keep the
image they started with; every new start uses the current version. The job is kept in memory: the overview
shows the running one, else the last finished one since the gateway started. A gateway shutdown abandons a
running job and records it at once as failed, "The gateway restarted during the update." (audited before the
process exits); the next start sweeps its staging image. A job already promoting has recorded its outcome
before it removes the build a rebuild replaced, so a shutdown then loses nothing.

**Images**: `GET /control/agents/versions` lists `workspace-portal/workspace:<agent>-*` with the number of
starting or running workspaces on each version (`inUse`). `DELETE /control/agents/:agent/images/:version` refuses the current
version's image (409 `image_current`), an image a container uses (Docker's 409, `image_in_use`), and any
image of an agent while a job updates it.

**Boot**: the gateway logs each agent's current and default version, and logs an error for each enabled
agent whose current image is missing (its starts fail until it is built or the admin updates it). Before the
control API listens it sweeps what interrupted jobs left behind, never forcing and keeping whatever is in
use: containers labelled `workspace-portal.verify`, every `workspace-portal/workspace-build:*` tag (only
those: an image that also has a workspace tag, as a gateway stopped mid-promote leaves it, keeps that), and
untagged images labelled `workspace-portal.agent` (`workspace-image/Dockerfile` labels each agent stage: an
old build whose tag a rebuild moved while a workspace still used it). It logs what it removed.

## Live view (`GET /control/live`)

Admin > Usage opens it through the web app (`/api/admin/live`). Server-sent events: `init` once, then
`frame` every 500 ms. The running workspaces are not in it: Admin > Users polls the workspace list
(`/api/admin/overview`), which costs hostd nothing. Nor are the workspace sessions: a frame carries their
`sessionsVersion`, and the page reads its table again (`/api/admin/llm-sessions`) when that changes. Everything behind it runs only while at least one viewer is connected (at most 8):

* **Server readings** (`host-monitor.ts`): one event stream per portal-hostd (`GET /v1/stream`), opened at
  the first viewer, closed 15 s after the last left, reconnecting with backoff (1 s doubling to 5 s). The
  last minute of readings is kept for a new viewer's charts. A host is `off` (no token), `connecting`,
  `online` or `offline` (with the error). Each frame adds the host's `today` from the energy meter's memory
  (see Energy meter), which runs all the time; frames never read the database for it.
* **LLM sessions** (`llm-monitor.ts`, `llm-requests.ts`): every 500 ms `GET LLM_UPSTREAM_URL/slots`
  (llama.cpp's server and engines derived from it, such as gufo; about 2 KB, prompt text not included)
  gives each engine session's prompt progress and generated-token count. The gateway's own record of each
  generation request (user, queued, forwarded, first token, tokens streamed, the engine's closing `timings`)
  says whose it is: the engine numbers requests in arrival order and the gateway forwards them in order, so
  new sessions are paired, in task order, with the oldest unpaired requests forwarded before the session
  was first seen.
  * Read = prompt tokens read per second of wall-clock time since the session was admitted (what the person
    waits, the engine's time shared among sessions). A session already under way when the first viewer arrives
    counts from then on: what it read before isn't spread over the first seconds. Write = generated tokens per
    second over the last 3 s.
    Totals add up the sessions still reading (Read) and those writing (Write).
  * A server without `/slots` (another engine): the rows come from the gateway alone (Write from the
    streamed tokens; Read only for finished requests). `503` = the engine is loading; no answer = offline.
  * Cost: the response stream is read for token usage anyway; the record adds a counter per event.

```ts
type LiveInit = { frameMs: 500; history: { portal: HostSample[]; llm: HostSample[] }; llmHistory: Array<{ t; readTps; writeTps }> };
type LiveFrame = {
  t: number;                                       // gateway time, for "since" values
  hosts: { portal: HostLive; llm: HostLive };      // HostLive = { role, state, error, info: HostInfo | null, sample: HostSample | null,
                                                   //   today: { day: "YYYY-MM-DD"; energyWh: number | null; rxBytes; txBytes } | null }
  llm: {
    engine: "ready" | "loading" | "offline" | "unknown"; sessionsReported: boolean; engineSessions: number | null;
    maxConcurrency: number; inFlight: number; queued: number; paused: boolean;   // paused: an engine update holds new requests
    sessions: Array<{ slot: number | null; userId: number | null; userName: string | null; phase: "preparing" | "reading" | "writing";
                      promptTokens; cachedTokens; processedTokens: number | null; generatedTokens: number;
                      readTps: number | null; writeTps: number | null; startedAt: number }>;
    waiting: Array<{ userId; userName; since; stage: "portal" | "engine" }>;   // portal: the gateway's queue; engine: no free engine session
    totals: { readTps: number; writeTps: number };
  };
  sessionsVersion: number;                         // changes whenever workspace_sessions does
};
```

`HostInfo` and `HostSample` are portal-hostd's (`hostd/README.md`; TypeScript in `gateway/src/hostd.ts`). From
hostd API version 2 on, a sample has `net` (`rxBps`, `txBps`: the physical interfaces together) and `disk`
(`readBps`, `writeBps`: the whole disks together; `totalBytes`, `freeBytes`: the local filesystems together),
and the info lists what they count (`network.interfaces`, `disks.devices`, `disks.mounts`). An older hostd
leaves them out; a source a machine lacks is null.

## Workspace sessions

Admin > Usage's table: each run of a workspace and what its LLM requests added up to (`workspace_sessions`).

* `session-log.ts` opens a row when a workspace starts (the workspace manager hands it every state it saves)
  and closes it when the workspace stops or fails; a start that fails before the workspace ran leaves no row. At the
  gateway's start it closes the rows of workspaces that are no longer running.
* Each generation request belongs to the session that was open when the gateway forwarded it, so one still
  running at the stop counts too. When it finishes the row adds one request (and one failed, if it failed),
  its tokens (the stream's `usage`, else the engine's `timings`), the engine's read and write tokens and times,
  and its time from forwarded to finished.
* Energy (`llm-energy.ts`): while requests run, the LLM server's portal-hostd meter (`GET /v1/meter`, kept
  every 2 s) is read every 2 s; each stretch's energy is shared among the requests running in it in proportion
  to their time in it (by the meter's own clock, unless it is more than 5 s off the gateway's), and added to
  their sessions with the time each had a request running (a session's parallel requests count once). Idle, it reads nothing. Without a meter (no token, or hostd before API version 2) the energy
  stays null.
* Cost (web, `lib/workspace-sessions.ts`): the energy at the chosen place's price on the day the session
  started; a price standing in for a month not yet published is marked as an estimate.
* Every write bumps a version, which the live frame carries.

## Energy meter

`energy-meter.ts` keeps each server's energy use and network traffic per local day in `host_daily` (two rows
a day, kept for good; Admin > Energy prices them, see Electricity prices). It runs from the gateway's start,
whether or not anyone watches:

* Every 30 s, `GET /v1/meter` from each set-up portal-hostd (`HOSTD_PORTAL_*`, `HOSTD_LLM_*`): running totals
  since hostd started, `{ instance, startedAt, t, energyJ, rxBytes, txBytes }` (hostd/README.md). hostd keeps
  them every 2 s whatever the live view does: the energy behind the samples' `power.watts` (APU socket power
  integrated; Intel RAPL package + DRAM, exact) and the bytes on the physical interfaces.
* The increase since the reading before, stored in `host_meter` (one row per server, so a gateway restart
  counts only what is new): the same `instance` gives current − last, a total that went back counts as a
  reset (current); a new `instance` is a restarted hostd, whose totals began at zero (current).
* The increase goes to the local day (`usageDay()`) of its interval (since the last reading; since hostd
  started for a new instance), split in proportion to time over every midnight it spans: `energy_wh += J /
  3600`, `rx_bytes`, `tx_bytes +=`. `energy_wh` stays NULL while the server's power can't be measured. One
  transaction per poll.
* A hostd that can't be reached, or without `/v1/meter` (404: hostd before API version 2), is skipped and
  logged once per change; what it counts meanwhile arrives with its next reading.
* Days are local to the gateway's `TZ`, which `docker-compose.yml` passes to both services (the web app's
  "usage today" uses the same day). `deploy/install.sh` records the host's zone in `.env`; without one the
  containers count UTC days.

## Electricity prices

`energy-prices.ts` downloads the published prices of every place in `energy-locations.ts` into `energy_prices`:
at the gateway's start, every 24 h, and when the admin picks a place with no prices stored yet (`POST
/control/energy-prices/refresh`; a source fetched in the last 10 minutes is not asked again). Neither source
needs an account or key; each answer is read up to 2 MiB with a 20 s timeout.

* **United States** (51 places, the states and DC): EIA's Electric Power Monthly, Table 5.6.A (HTML), the
  average residential price in cents per kWh for the latest month and the same month a year before. EIA
  publishes about two months late and revises recent months, so a later download replaces a month's figure.
* **Europe** (39 countries, Eurostat's codes): Eurostat `nrg_pc_204` (JSON-stat), household prices with all
  taxes, consumption band 2,500-4,999 kWh a year, euros per kWh, the last six half years.
* A page that doesn't parse as the table it was (too few places, a changed layout) is an error in the log and
  in `GET /control/energy-prices`; what is stored stays as it was. A wrong price is never written.
* The web app (`web/lib/energy.ts`) prices each day at its place's period that contains it; a day past the
  latest published period uses that latest figure, marked as such on the page. Without a place chosen, Admin >
  Energy shows energy only and links to Settings.

## LLM engine updates

Admin > Updates switches the LLM engine on the LLM server to another release, newer or older
(`engine-updater.ts`), through that server's portal-hostd, which owns the engine's Podman quadlet
(`hostd/README.md`).

* **Versions** (`engine-releases.ts`): the stable `X.Y.Z` tags of the engine image's repository (the
  quadlet's `Image=` repository, as portal-hostd reports it), the newest 8 from its registry (Docker Registry
  v2 with the anonymous token challenge, as ghcr.io and Docker Hub use), each with its digest (`HEAD` of the
  manifest). Offered, as for the agents: the 5 newest up to the one `latest` points at (a tag pushed but not
  yet latest isn't), plus what runs and every image on the LLM server with a version label (its own digest),
  newest first. Release notes and their dates come from `ENGINE_RELEASE_NOTES_REPO`'s GitHub releases (the
  same client as the agents', `github-releases.ts`; stable releases only). Cached 10 minutes; a failed check
  keeps the last list, reports the error and is retried after a minute. A GitHub failure is no registry error:
  it keeps the last notes and is only logged. Registry answers are read up to 4 MiB.
* **An update** (one job at a time; an older version the same way):
  1. `pulling`: the version's digest is resolved from the registry at once, and portal-hostd pulls
     `<repository>@<digest>` while the engine keeps serving. Cancellable. An image of that version already on
     the LLM server is used as it is instead (`reuse: true`, "Using the image already on the LLM server" in the
     log): no registry, no download, the job starts at `draining`.
  2. `draining`: the gateway's LLM queue grants nothing new (requests wait in the queue; they don't fail),
     and the job waits until no request is in flight, for at most `ENGINE_DRAIN_MINUTES`, or until the admin
     says "Restart now". Cancellable (the queue opens again; nothing changed).
  3. `restarting`: portal-hostd writes the new image into the quadlet, restarts the engine and checks that it
     answers `/ready` with the new version in `/props`; if not, it writes the old quadlet back and restarts
     that (`rolledBack`).
  4. The queue opens again in every case; the held requests go to the engine that now runs.
* Audited `engine_updated` / `engine_update_failed` (cancellations too, error "Cancelled."). A gateway
  that stops during a job records it failed; portal-hostd finishes what it was doing on its own.
* The deploy scripts refuse to run while a job is downloading, draining or restarting
  (`console_update_running`).

```ts
type EngineOverview = {
  state: "off" | "offline" | "no_engine" | "ok"; error: string | null;
  engine: EngineStatus | null;                     // portal-hostd's GET /v1/engine (hostd/README.md)
  releases: { repository: string; releases: Array<{ version: string; digest: string | null; latest: boolean;
              notes: { title; url; publishedAt; body /* markdown */; breaking: boolean } | null }>;
              checkedAt: number | null; error: string | null } | null;
  job: EngineUpdateJob | null;                     // the running job, else the last since the gateway started
  drainMinutes: number;
};
type EngineUpdateJob = {
  id: string; fromVersion: string | null; toVersion: string | null; image: string | null;
  reuse: boolean;                                  // the image was on the LLM server: no download
  stage: "pulling" | "draining" | "restarting" | "succeeded" | "failed" | "cancelled";
  step: string; log: string[];                     // the gateway's notes and portal-hostd's job logs, last 400 lines
  startedAt: number; finishedAt: number | null; error: string | null; rolledBack: boolean;
  drain: { since: number; deadline: number; inFlight: number } | null;
  cancellable: boolean; actorUserId: number | null;
};
```

## Agent ports (AGENT_BIND:AGENT_PORT_BASE+1 … +COUNT-1, ONLINE_AGENT_PORT_BASE+1 … +COUNT-1)

The gateway listens on every port of both ranges (Online's too while `ONLINE_WORKSPACES` is off: they answer
that the workspace is stopped). The port says whose workspace a request is for and which kind, and it gives
every workspace, and each of a user's two, its own browser origin. Origins matter because the agents' UIs keep
state (prompt history, service workers, the Web Shell's token) per origin and run same-origin scripts (the Web
Shell's `/mcp-app-sandbox`); one shared origin would let one user's page read another's, and a page the agent
built in Online (CDN scripts and all) read what the Private one left in the browser.

What differs per agent comes from its driver (`gateway/src/agents/`: `qwen.ts`, `dsh.ts`, the interface in
`driver.ts`); everything else below applies to both:

| | Qwen Code (`qwen`) | DeepSeek Harness (`dsh`) |
|---|---|---|
| Container port | 4170 | 3080 |
| Browser auth | token (fragment → bearer) | none: the gateway mints the cookie |
| Upstream `Host` / `Origin` | the container address | `localhost:3080` / `http://localhost:3080` |
| Blocked paths (403) | `/web-shell/pairing*` | `/connect*`, `/oauth*`, `/open-in-app*` |
| WebSocket paths | `/terminal`, `/acp`, `/live/web` | `/api/remote.mux` |
| Person activity (besides navigations and socket messages) | non-GET/HEAD/OPTIONS except `*/heartbeat` | non-GET/HEAD/OPTIONS except the RPCs its UI sends on load or when a terminal opens (lists, catalogs, `session/create`, `session/state`, …) |

For every HTTP request and WebSocket upgrade (`agent-access.ts`, `agent-proxy.ts`, `ws-relay.ts`):

1. **Host and origin.** `Host` must parse. An `Origin` header must equal `http://<Host>` (403
   `forbidden_origin`). `Sec-Fetch-Site: cross-site` is refused for non-GET/HEAD requests and for upgrades
   (403 `forbidden_cross_site`). `Sec-Fetch-Site: same-site` (another port of this host: the portal, another
   workspace, the user's other kind) is refused unless it navigates an iframe (`Sec-Fetch-Mode: navigate`,
   `Sec-Fetch-Dest: iframe`, GET or HEAD), which is all the portal does (403 `forbidden_same_site`). Same-site
   requests carry the `SameSite=Lax` session cookie even when a page merely loads an image or script, and a
   GET has no `Origin`: without this a page on the Online origin could make the browser send requests to the
   Private agent that the gateway would authenticate (and, for dsh, sign a cookie for).
2. **Session.** Read `portal_session` and call `loadSessionContext`. With no valid session, navigations get
   the themed "You're signed out" page linking to `//<host>:WEB_PORT/login`; everything else gets 401
   `unauthenticated`.
3. **Port user and kind.** `target.id` must equal the port's user. Otherwise navigations get "This workspace
   isn't open here" with a link back to the portal, and everything else gets 403 `other_workspace`. An admin
   reaches user N's ports only after "Open workspace" set `acting_as_user_id = N`. A kind's port reaches only
   that kind's container (`manager.upstream(userId, kind)`): while the other kind starts, runs or stops,
   navigations get "Your Online (Private) workspace is running, not this one" with a link to the portal (409),
   everything else, WebSockets included, 409 `kind_mismatch`; nothing is forwarded.
4. **Presence.** The request marks this session as having the workspace open for 20 s (`connections`,
   "Admin connected"). An open Web Shell tab polls every few seconds; an open dsh tab keeps its
   `/api/remote.mux` socket, which counts as open for as long as it lasts.
5. **Blocked paths.** The agent's blocked prefixes (table above; matched on the canonical, lowercased
   path, so no spelling gets around them) get 403 `not_available`: device pairing and launch-token
   exchange would hand out access to the container, the rest needs the internet. Paths under `/__portal/`
   are the gateway's own: `POST /__portal/start` is the "Try again" form of the error and capacity pages.
   It starts this port's kind, with the same checks as the portal's Start (Online's permission and switch
   included: 403/409 pages), and answers 303 to `/`.
6. **Token** (token agents). See "Agent credentials and browser auth". Any token the browser presents
   must be this session's token for this port's workspace and kind, whatever the agent: a wrong one gets 401
   `invalid_token` before anything else. WebSockets carry it as the subprotocol `qwen-bearer.<token>`
   next to `qwen-ws`. The relay strips it, opens the upstream socket with the real token in the
   Authorization header, and echoes the subprotocol the container selected. A cookie agent gets the
   minted cookie on every request and upgrade instead.
7. **Not running.** Nothing on an agent port starts a workspace by itself: the kind is chosen and confirmed
   in the portal. A document navigation (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` when that header
   is missing) gets a themed 503 page for this kind's state:
   * Starting (or running but not ready yet): "Starting your Private (Online) workspace…", reloading every 2 s.
   * After a failed start: an error page with `lastError` and "Try again" (`POST /__portal/start`).
   * Stopped (a crash included): "Your Private (Online) workspace is stopped", with a link to the portal.
   * Everything else, WebSockets included, gets a 503 `{error, message}` (`workspace_starting` with
     `Retry-After: 2`, `workspace_error`, `workspace_stopped`). An open tab's reconnect loop must not wake a
     stopped workspace.
   * "Try again" at the cap with nothing to evict gets the capacity page; while the user's data is being
     deleted, a 503 page; nothing starts.
8. **Forwarding.** Requests go to `http://<container ip>:<agent port>`.
   * Cookie, Origin, Forwarded/X-Forwarded-* and Sec-Fetch-* are stripped, and Host is rewritten (both
     agents check Host and Origin): for Qwen Code to the container address; for dsh to `localhost:3080`,
     with the minted cookie and, if the browser sent an Origin, the matching one.
   * On responses: `X-Frame-Options` is removed, and the CSP gets `frame-ancestors http://<host>:WEB_PORT
     https://<host>:WEB_PORT`, so only the portal's own pages can frame a workspace.
   * Cache-Control is kept when it says `no-cache`, `no-store` or `immutable`; otherwise it becomes
     `private, no-store`.
   * `UPLOAD_LIMIT_MB` is enforced: 413 up front from Content-Length, and a streamed body is cut at the limit.
   * An unreachable container gives 502 `workspace_unreachable` (navigations get a themed page) and
     triggers a container check.
   * Event-stream responses and WebSockets are tracked per workspace and session, so
     `/control/sessions/:id/disconnect` and stops can close them. Every 60 s the gateway also closes those
     whose session no longer exists or has expired (WebSocket close code 4001).
   * The agent and service servers have no overall request timeout (streams and uploads can run long),
     but request headers must arrive within 60 s.
9. **Person activity** (`touch`): a document navigation, a request the agent's driver counts
   (`isUserAction`, table above), or a WebSocket message from the browser. Polls, heartbeats, event
   streams and frames from the container don't count, so an open but unused tab lets the workspace go
   idle (an idle dsh tab sends nothing at all). `last_activity_at` is flushed to SQLite at most every 30 s.
10. WebSockets: only the agent's paths (table above; others 404). The relay pings the browser every
    20 s, drops it after 2 missed pongs, and applies backpressure at 4 MiB buffered.

## Service API (WORKSPACE_GATEWAY_IP:SERVICE_PORT and ONLINE_GATEWAY_IP:SERVICE_PORT), for workspace containers

One listener per kind, on the host's address on that kind's network (the Online one only while Online is on;
each waits for its bridge address to come up). The caller is identified by source IP, within that listener's
kind only: the gateway maps each running workspace's container IP to its userId (`userIdForIp(kind, ip)`), so
the Private listener never answers an Online container and the other way round (and the firewall lets neither
network reach the other's listener). Unknown sources get 403. Containers have no capabilities and
inter-container traffic is off, so they can't spoof an address. Each listener keeps its own per-workspace
state (the read-page `ShownUrls`, the search and read limits): nothing an Online workspace was shown opens a
page for the Private one.

```
POST /llm/v1/chat/completions, /llm/v1/completions, /llm/v1/embeddings  → LLM_UPSTREAM_URL/v1/…  streaming pass-through
GET  /llm/v1/models, /llm/v1/models/<id>                                → LLM_UPSTREAM_URL/v1/…
POST /mcp/search                                                         → built-in MCP server (streamable HTTP, stateless): web_search, read_page
```

* One source address may have at most 128 connections open; further ones are closed at once.
* Checks run in this order: an unknown caller gets 403; a path with `.`/`..` segments, backslashes, or
  percent-encoded `.`, `/` or `\` gets 400; then the allowlist above. Any other `/llm/v1/` path gets 404
  `{error: {message, type: "not_found"}}`, a listed path with the wrong method 405 `method_not_allowed`
  with an `Allow` header. Other paths get 404.
* **LLM.**
  * Any incoming Authorization is replaced with `LLM_API_KEY` (or dropped). Workspaces hold the placeholder
    key `portal` in `PORTAL_LLM_KEY`.
  * Queue limits: a global limit of `LLM_MAX_CONCURRENCY`, and `LLM_MAX_CONCURRENCY_PER_USER` per user. The
    queue is FIFO, and a user at their limit doesn't hold up others. Only generation requests take a slot.
  * A request that is queued or in flight marks the workspace busy. When a workspace hangs up, the upstream
    request is aborted and its slot freed.
  * Usage is counted per user per day in `llm_usage` (requests, plus tokens from `usage`). If the upstream
    is down: 502 with an OpenAI-shaped error (`llm_unreachable`).
* **Search** (`search-mcp.ts`).
  * MCP protocol versions are 2025-11-25 back to 2024-11-05. The server offers `web_search`
    (`query`, `page`, `time_range`, `language`) and, when there is a reader, `read_page` (`url`, `start`).
    A request body is at most 64 KiB and a JSON-RPC batch at most 8 messages.
  * Each search queries `SEARXNG_URL/search?format=json`, adding `SEARXNG_AUTHORIZATION`, with
    `SEARXNG_TIMEOUT_SECONDS` and a per-workspace concurrency limit.
  * A search that returns fewer than `SEARCH_FALLBACK_BELOW` results is asked once more with
    `engines=<SEARCH_FALLBACK_ENGINES>`, and the new results are appended. A failing second request leaves
    the first answer. Each use is logged (`web search: fallback engines asked`, with the result counts
    before and after).
  * Results are text: up to 10 results, each with a title, URL and a snippet cut to 500 characters, then
    SearXNG's spelling corrections if it has any. Its `suggestions` are left out: they are the engines'
    autocompletions of the query. With no results, the text names the engines SearXNG reported as
    unresponsive and says that rewording will not help; if all engines answered, it says so.
  * An answer with results is kept for `SEARCH_CACHE_MINUTES` under (query in lower case, page, time range,
    language), at most 256 entries.
  * A call counts as agent activity.
* **Page reading** (`reader.ts`, `url-policy.ts`, the `read_page` half of `search-mcp.ts`).
  * Access. `READER_URL_POLICY=shown`: the gateway keeps, per workspace and in memory, the URLs that
    workspace was shown (`ShownUrls`): every URL in the text of its search results and of the pages it
    read, and every URL in the non-assistant messages (and `prompt`) of its generation requests, collected
    as the request body streams to the LLM server (bodies over 8 MB are not scanned). `read_page` is
    allowed for a shown URL, and for any URL whose host is one of `READER_TRUSTED_HOSTS` or a subdomain of
    one. Anything else is refused before the reader is asked.
  * One spelling. Every URL is parsed and written out again (`canonicalUrl`: dot segments resolved, host
    in ASCII, no fragment, at most 2000 characters) before anything else is done with it, and that string
    is what is remembered, compared and sent to the reader. A requested URL matches a shown one when they
    are equal, or differ only in the scheme or in one trailing slash; the reader is then asked for the
    spelling that was shown. So nothing a model adds to a shown URL (`/secret/../page`, a fragment, another
    spelling of the host) reaches the site.
  * What does not count as shown: assistant messages, so a URL does not become shown by the model writing
    it; and URLs in a search query, although the answer repeats the query (and a spelling correction may).
    Tool output does count, so a model that prints a URL through a tool and opens it afterwards passes:
    the rule stops the common injection, not a determined one. A model can also choose *which* of the URLs
    it was shown to open.
  * Bounds: 20,000 URLs and 2 million characters per workspace (oldest dropped), and the sets of at most
    `max(16, 4 x MAX_RUNNING_WORKSPACES)` workspaces (the one unused for longest is dropped; its next LLM
    request shows it its conversation again). Extracting URLs from text is linear in its length.
  * Redirects. For a shown URL the reader follows redirects to any public address. For a URL that passed
    only because its host is trusted, the gateway sends the trusted list along (`redirect_hosts`) and the
    reader refuses a redirect that leaves the page's own host for a site outside that list.
  * The gateway asks the reader with `POST READER_URL/read {"url", "redirect_hosts"?}` and keeps the
    answer for `READER_CACHE_MINUTES` (at most 64 pages and 8 million characters, shared by all
    workspaces, keyed by the URL and by whether the read was fenced; concurrent reads of one URL share a
    download; a refusal that will repeat, such as a missing page, is kept for 2 minutes). An answer over
    4 MiB is not accepted.
  * A workspace's read slot (`READER_MAX_CONCURRENT_PER_USER`) is held until the download ends, not until
    the workspace hangs up: a download that others may be waiting for is never cancelled.
  * The answer to the model is a header (`Title:`, `URL:` after redirects, `Note:`), then
    `READER_PAGE_CHARS` characters of the page from `start`, ending at a line break where one is near, then
    either `[Characters a-b of N. To continue, call read_page with the same url and start=b.]` or an
    end-of-page line.
  * A call counts as agent activity.

## Page reader (`reader/`)

One request, one process: `reader.py` forks for every request, with a CPU limit, a heap limit and a kill
timer on the process. `READER_MAX_CONCURRENT` of them work at a time, each holding a lock on a file in
`/tmp` that the kernel releases when the process ends; up to 14 more wait at most 30 s for a place and are
then answered `busy`. `/healthz` never waits. Answers are always HTTP 200 with
`{"ok": true, url, kind, title, text, truncated, note}` or `{"ok": false, code, message}`, where `message`
is written for the model.

* What is fetched: `http`/`https`, ports 80 and 443, `GET`, no cookies, no credentials in the URL, a URL of
  at most 2000 characters. Host names are IDNA-encoded and must look like public names: at least one dot,
  no IPv6 literal, none of the local suffixes (`.local`, `.internal`, `.lan`, `.home.arpa`, …).
* Where it connects: the name is resolved to IPv4 addresses only, every address must be public (Python's
  `is_global`, plus the IANA special-purpose ranges), and the TCP connection goes to the address that was
  checked; the name is used only for TLS and the `Host` header. A redirect (at most 5) is parsed, checked
  and resolved like the first URL. A GitHub file view (`/blob/`) is read from `raw.githubusercontent.com`.
* Limits: `READER_FETCH_TIMEOUT_SECONDS` for the whole download, however slowly a site sends (each read
  takes what has arrived and waits no longer than the time left), `READER_MAX_DOWNLOAD_MB` after decompression
  (gzip and deflate only), `READER_MAX_PDF_MB` and `READER_MAX_PDF_PAGES` for PDFs, 400,000 characters of
  output.
* Content. `Accept` asks for `text/markdown` first; markdown and other text are returned as they are.
  HTML goes to `extract.mjs`, a Node process per page (25 s, 256 MB heap) that runs Defuddle with four
  corrections for documentation pages (same-page cross-references, anchor ids, code blocks restored
  verbatim with their language, the main heading). If it fails, or returns almost nothing from a page that
  has text, the page's text is returned unfiltered with a note. PDFs are read with pdfium, page by page.
  No JavaScript runs anywhere.
* The image build runs the reader's tests (`test_reader.py`, `test_extract.py`); a build whose address
  checks, converter or PDF reader fail does not produce an image.

## Agent settings rendering

At every start the gateway renders the settings of the agent being started (`driver.renderSettings(config,
kind)`) into `users/<id>/<kind>/system/<agent>/` and mounts that directory read-only at the agent's settings
path. The two kinds' settings differ only in the service address (`<service>` below): the kind's own gateway
IP, `http://WORKSPACE_GATEWAY_IP:SERVICE_PORT` for Private, `http://ONLINE_GATEWAY_IP:SERVICE_PORT` for
Online. Unusable
admin settings throw `AgentConfigError`: the start fails with its message, and the gateway logs it at boot
for every enabled agent. The admin configures both agents through Qwen Code's two files; DeepSeek Harness
takes only the model list from them.

### Qwen Code (`agents/qwen-settings.ts`)

At every Qwen Code start the gateway reads the admin's `config/qwen/settings.json` and `system-defaults.json`
(JSONC; a missing file counts as `{}`) and writes per-user copies into `users/<id>/<kind>/system/qwen/`. The image
points `QWEN_CODE_SYSTEM_SETTINGS_PATH` and `QWEN_CODE_SYSTEM_DEFAULTS_PATH` at them. Qwen Code's precedence
is system-defaults < user < workspace < system.

* `system-defaults.json` is the admin's file, which must define at least one model under
  `modelProviders.openai` (otherwise the start fails with an `AgentConfigError`).
  * Only `modelProviders.openai` survives.
  * Every entry gets `baseUrl = <service>/llm/v1` and `envKey = PORTAL_LLM_KEY`,
    and loses `apiKey`.
  * `security.auth.selectedType` is set to `openai`.
* `settings.json` is the admin's file plus forced keys.
  * Turned off: `general.enableAutoUpdate`, `general.preventSystemSleep`, `privacy.usageStatisticsEnabled`,
    `telemetry.enabled` and `telemetry.logPrompts`, `model.catalogRefresh`.
  * `security.auth.enforcedType` and `selectedType` are set to `openai`. `permissions.deny` gains
    `web_fetch`. `tools.webSearch` is removed.
  * `mcpServers.search` is set to `{httpUrl: <service>/mcp/search, includeTools: ["web_search", "read_page"],
    trust: true}` (`["web_search"]` without a reader).
  * With `WORKSPACE_BROWSER=true`, `mcpServers.browser` runs `playwright-mcp --headless --isolated
    --no-sandbox` with the image's Chromium and output in `/workspace/.browser`. Otherwise
    `mcpServers.browser` is removed.
* **Default effort** (`DEFAULT_REASONING_EFFORT`, default `low`; `model` turns this off). Every model in
  either file whose `capabilities.reasoning.efforts` offers it gets it as its `defaultEffort`, and when the
  default model (`model.name`, from the list settings.json's replaces system-defaults.json's with) offers it,
  settings.json gets `model.reasoningEffort`. That is the system scope, which beats the user scope where
  Qwen Code saves a pick: a person can change the effort within a session, and the next session starts at
  the default again. DeepSeek Harness takes its default effort from the same rendered settings.
* Merging is deep for objects; arrays are replaced, and `__proto__`/`constructor`/`prototype` keys are ignored.
* A parse error is an `AgentConfigError` naming the file.

The container also gets `QWEN_USAGE_STATISTICS_ENABLED=false` and `QWEN_PERMISSION_TIMEOUT_MS` (the idle
timeout). The image sets `QWEN_TELEMETRY_ENABLED=false`, `DO_NOT_TRACK=1`, `NO_UPDATE_NOTIFIER=1` and npm's
no-update-notifier/no-audit/no-fund flags.

**Web Shell trim** (image build: `workspace-image/qwen/trim-web-shell.mjs` on the installed package's
`web-shell/`, bind-mounted, so the script isn't in the image). The Web Shell app hard-codes its shell
component's options, so no setting reaches them, and `tools.approvalMode: "plan"` is no substitute: it would
also put the terminal's `qwen` and headless `qwen -p` (which can't leave plan mode) in plan mode, and approved
plans would run with "Ask" approval. Two layers, each working without the other:

* The app bundle (the `type="module"` entry in `index.html`). Three edits, each applied only when its pattern
  matches exactly once (minified names as `[\w$]+`):
  * `sidebar`: `showLive` and `showSessionSourceSwitch` off, `primaryNav.items` `["newTask", "agents"]`,
    `footer.items` `["collapse"]`. That leaves Home and the toggle in the rail and New session in the list;
    no Activity view, Plugins, Channels, Channel events, Live, Scheduled Tasks, PR watches, Goals, Workflows,
    Managed, nor the "More" menu (Settings, theme, Session Overview, Split View, Daemon Status, Local files,
    Use this computer). The Web Shell drops its rail when no nav entry besides `newTask` qualifies; `agents`
    keeps it, and its own button shows only with Qwen Code's agent collaboration, off by default (the
    stylesheet below hides it anyway).
  * `header.showMobileAccess` off (Local Control pairing, which the gateway blocks anyway).
  * Plan mode on for new sessions: in the effect that sets the composer's Plan toggle from the session's
    mode, a mode other than `plan` without a session becomes `plan`, with that mode kept as the plan's
    execution mode. That is what the + menu's toggle does, so the approved plan runs in the mode the composer
    shows (Classifier Approval by default). A session shows its own mode; a toggle switched off before the
    first prompt stays off.

  The result must parse (`node --check` on a temporary copy). It is written next to the original as
  `<entry>.portal-<sha256 prefix>.js`, `index.html` loads it, and an import map sends the other chunks'
  imports of the original entry to it. The original file stays: `qwen serve` sends hashed `/assets` as
  `immutable`, and the gateway keeps that, so an edit in place would not reach browsers (or the Web Shell's
  service worker cache) that hold the shipped file.
* A `<style data-workspace-portal>` before `</head>`, keyed on the Web Shell's `data-*` attributes and lucide
  icon classes (its labels are translated, its class names hashed): in `nav[data-web-shell-navigation-rail]`
  every button but `[data-web-shell-home-trigger]` and `[data-web-shell-sidebar-collapse]`, the
  `svg.lucide-bell` button in `[data-sidebar-shell]` (Activity) and the `svg.lucide-qr-code` button in the
  header (Mobile access) are hidden. It covers the rail and header when the bundle edits no longer fit;
  routes such as `/plugins` stay reachable by URL either way.

The script never fails the build: whatever doesn't fit is skipped with `trim-web-shell: warning: ...` in the
build log and stays as shipped. A second run finds the marker and changes nothing.

### DeepSeek Harness (`agents/models.ts`, `agents/dsh-settings.ts`)

`start-dsh` runs `dsh --profile web --patch <lockdown> --patch <portal>`. Patches apply after the user's
own `~/.dsh/profiles/web/cordis.patch.yml` (where the UI saves settings), so neither can be overridden from
the UI, which shows those plugins read-only.

* **Lockdown** (static, in the image: `workspace-image/dsh/lockdown.patch.yml` →
  `/usr/local/share/workspace-portal/dsh/lockdown.patch.yml`). Top-level rows only, by id. dsh merely warns
  about a row whose id doesn't exist, so the image build composes the profile with the lockdown
  (`workspace-image/dsh/check-lockdown.sh`, `dsh --dump-config`) and fails on any such warning: a dsh update
  that renames or removes a row fails instead of shipping a weaker lockdown, and the current image stays.
  Rows marked `# optional` (plugins some supported versions no longer have) may be missing. The check adds
  a canary row with an id that exists nowhere and fails unless dsh reports it as it expects ("dsh's patch
  warnings changed"), so a dsh that rewords its warnings can't make every lockdown pass.
  * Off (they need the internet or the host): the DeepSeek account and LLM routes, the built-in web and
    web-search tools, `web_fetch`, the plugin manager and market, feedback upload, open-in-app, the sidebar
    browser. Telemetry is off in the image (`DSH_TELEMETRY_DISABLED=1`).
  * `credentials.path: /tmp/dsh-credentials.yaml` (the cookie secret, see above).
  * One workspace, `/workspace` (the documents directory's default workspace is a symlink to it in the
    image), and no directory picker.
  * The agent's bash runs under dsh's Landlock sandbox, `workspace-write`: without asking it may write
    `/workspace`, `/tmp`, `/dev/shm` and the home caches (`~/.cache`, `~/.local`, `~/.npm`); anything
    else (notably `~/.dsh`, `~/.agents` and shell start-up files, which run unconfined later) needs an
    approval (`approval.policy: ask`). The UI's terminal is the person and is not confined.
  * All four agent presets (standard, ptc, minimal, cordis) stay available. Their plugin rows can't be
    patched one by one (a patch replaces a preset's whole config), so the image build adapts dsh's shipped
    preset files in place (`workspace-image/dsh/adapt-presets.mjs` on `dsh-web-app/presets/*.patch.yml`):
    the `tool-web` and plugin-manager/market tool rows get `disabled: true` (an existing value is replaced where
    it stands, keeping its comment), the rest stays byte-for-byte as shipped, including `!!js` expressions
    that resolve relative to the file. The build fails if the presets
    are missing or a listed row stays enabled.
* **Portal patch** (rendered per start: `users/<id>/<kind>/system/dsh/portal.patch.yml` →
  `/etc/workspace-portal/dsh/`). JSON (valid YAML) under a `#` comment, so admin-supplied names and ids stay
  quoted strings and can never become YAML tags (dsh evaluates `!!js`).
  * The models: `portalModels` reads the rendered Qwen Code `modelProviders.openai` (settings.json's list
    replaces system-defaults.json's) into one provider, `portal`, `openai-completions` at
    `<service>/llm/v1` with the placeholder key. Per model: id, name, context window
    (`generationConfig.contextWindowSize`, default 131072), output cap (`samplingParams.max_tokens`,
    default 32768), image input, reasoning efforts (`capabilities.reasoning.efforts`). The default model and
    effort are Qwen Code's.
  * `fitDshModels`: dsh's compaction needs `contextWindow − maxTokens ≥ 78020` (its 65536-token headroom
    plus the 16 % it keeps). Output caps are lowered to fit, keeping at least 4096; models with a context
    window under 82116 are left out. None left: `AgentConfigError`.
  * MCP servers: `search` (`<service>/mcp/search`, streamable HTTP) and, with `WORKSPACE_BROWSER=true`,
    `browser` (the same Playwright command as for Qwen Code).
  * Sampling parameters (temperature, top-p, …) are not passed: dsh has no setting for them, so the
    model server's defaults apply.

## Workspace lifecycle

* Container `wp-ws-<id>` (Private) or `wp-wo-<id>` (Online), with labels `workspace-portal.workspace=1`,
  `workspace-portal.user-id=<id>`, `workspace-portal.kind=<private|online>`, `workspace-portal.agent=<qwen|dsh>`
  and `workspace-portal.version=<version>`, runs as `User <base+id>:<base+id>` (the kind's UID base) from
  `workspace-portal/workspace:<agent>-<version>`, the agent's current version when it started (the manager
  resolves the image at each start; `agentVersion` in WorkspaceInfo). One per user, whichever agent and kind;
  the container spec (`container-spec.ts`) is the same for all apart from the image, the env, the settings
  mount and, per kind, the name, UID, mounts, network and DNS (Online: `Dns` = the two `ONLINE_DNS_*`,
  `DnsSearch: ["."]`). A container without a kind label (from before kinds) is Private.
* Mounts, of that user's kind only:
  * `users/<id>/<kind>/home → /home/user` and `users/<id>/<kind>/workspace → /workspace` (read-write);
  * `users/<id>/<kind>/system/<agent> → /etc/workspace-portal/<agent>:ro` (the running agent's only);
  * `system/passwd → /etc/passwd:ro` and `system/group → /etc/group:ro`.
* Hardening: `ReadonlyRootfs`, tmpfs `/tmp` (nosuid, nodev, `WORKSPACE_TMP`), `CapDrop: ALL`,
  `no-new-privileges`, memory (+512 MiB swap), CPU and PID limits, `ShmSize`, `OomScoreAdj 500`,
  `RestartPolicy: no`, and json-file logs capped at 10 MB × 3.
* Process (both scripts refuse to run as root):
  * Qwen Code: `tini` → `start-qwen` → `qwen serve --hostname <container ip> --port 4170 --workspace
    /workspace --permission-response-timeout-ms <idle timeout>`.
  * DeepSeek Harness: `start-dsh` (stores and drops the cookie secret) → `tini` → `dsh --profile web
    --patch <lockdown> --patch <portal> --no-open --host <container ip> --port 3080`, launched from an
    empty root-owned directory (dsh reads `.env` from its working directory).
* Start (`POST /control/workspaces/:id/start`; which agent and kind: see "One agent at a time" and "One kind
  at a time"):
  1. Remove a container a failed stop left behind; render the agent's settings for the kind; move the files
     of the layout from before kinds into `private/` (see Data directory); prepare the kind's directories
     (owner the kind's `base+id`, mode 0700) and write the settings and passwd/group.
  2. Generate the credential, remove any stale container of either kind, then create and start (`starting`).
  3. Poll the driver's readiness probe every 500 ms (90 s timeout) until it passes (`running`, `ready`):
     Qwen Code `GET /health?deep=1` answering 200 with `channelAlive`; dsh its `session/list` RPC
     answering `ok` (not just any answer: its port returns 404 everywhere for a moment while it starts).
     `qwen serve` stops its agent process when no session is open and starts it again for the next one
     (about 2 s), so an unused workspace reports `channelAlive: false`. When it does, the probe asks
     `GET /daemon/status` and passes if `daemon.startup.preheat.status` is `succeeded`: the process has
     run once. Without this, a restarted gateway would wait 90 s for an unused workspace and remove it.

  A failure or exit leads to `error` with `lastError` (including the last log lines), and the container
  is removed.
* A container that dies is noticed within 15 s or on the next failed proxy request. It becomes `stopped`
  with `stopReason: "error"`, audited as `workspace_error`.
* Stop: `stop -t 10`, then remove. Data stays in the bind mounts. If Docker fails to remove it, the
  container is kept as a leftover (its id stays in the row): reconcile retries the removal, and it is never
  adopted again. The same holds for the cleanup after a failed start and for rows found `stopping` at boot.
* Every Docker API call has a 60 s timeout, except an agent update's image build (30 minutes, see Agent
  versions and updates).
* Gateway restart: workspace containers keep running. The next gateway adopts them (it reads the agent and the
  kind from the labels, the agent version from its label (from the image tag for containers older than that
  label: null once the tag has moved to a rebuild), its address on its own kind's network, and the credential
  back from the container's env) when it starts and every 5 min. Orphans are removed, and so is a container
  with an unknown kind label. An Online container is stopped instead of adopted while Online is off or not
  allowed for its user (audited `workspace_stopped` with that reason). A container IP claimed by a newer
  workspace of the same kind is taken from the old entry, whose container is then checked. After the first
  reconcile the gateway moves the files of the layout from before kinds for every user without a container.
* At boot the gateway exits unless the Docker Engine is 25.0.5 or newer (CVE-2024-29018: older engines
  forward DNS queries from internal networks). It logs the agents' current versions, renders every enabled
  agent's settings and checks that the image of its current version exists, logging what is wrong (starts
  of that agent then fail with the message). It creates or verifies the Private network and, while Online is
  on, the Online one.

### Busy and idle

Every 15 s the gateway samples each running workspace:

* **Agent state** (`driver.fetchStatus`); `task` means the agent is working.
  * Qwen Code, from `GET /health?deep=1`: `activePrompts > 0`, or `activeWork` is true (tools, subagents,
    background shells, monitors; a stale report counts as working), or `pendingPermissions > 0`. An
    approval waiting for an answer counts as work, connected or not. `qwen serve` declines one nobody
    answers after `IDLE_TIMEOUT_MINUTES` (`--permission-response-timeout-ms`), and the idle countdown
    starts then.
  * DeepSeek Harness, from its API: a session whose turn is `running` (`session/list`), unless
    `session/state` says it only waits for the person (`pendingInput`: an approval or a question); or a
    background job still `running` in one of the 32 most recently used sessions (`job/list`, a stream,
    asked over one short-lived `/api/remote.mux` socket). dsh never times out a waiting approval, so it
    doesn't count as work: the idle countdown runs from the last activity, and an unanswered approval stops
    with the workspace. dsh reports no time of last activity, so the gateway times the end of the work.
  * When the agent doesn't answer, the last known state stays and is marked unknown. The agent then counts
    as working for 5 min after the last answer (a busy agent can be slow to reply), and as not working
    after that, so a broken agent can't keep its workspace up.
* **LLM:** a request queued or in flight in the gateway (`llm`).
* **CPU:** average use above 0.15 cores over the window (`cpu`).

`busyReason` is the first of these that applies. A busy workspace counts as active, and its idle countdown
starts when the work ends. Safety net: after `MAX_BUSY_HOURS` without person activity, work no longer counts,
and neither do the agent's own LLM and search calls: the idle countdown runs from the person's last action.
These rules are pure functions in `gateway/src/policy.ts`.

### Reaper (every 60 s)

For each running workspace, it computes a verdict, re-checks the agent state before acting, and then:

| Situation | Verdict |
|---|---|
| Online, and Online is off (`ONLINE_WORKSPACES`, or the host firewall's fence is not loaded) or not allowed for its user | stop, `online_disabled` / `online_not_allowed`, busy or not |
| busy | keep |
| no session uses it (everyone signed out, sessions expired) | stop, `logout` |
| not busy, idle ≥ `IDLE_TIMEOUT_MINUTES` | stop, `idle` |
| otherwise | keep |

* `release` (sign-out, admin exit, session deletion) behaves the same way right away. It re-checks the agent
  state, stops the workspace if it isn't busy, and otherwise sets `stopPending`. The reaper stops it once
  the work is done.
* A new sign-in clears `stopPending`.
* Admin stop, deactivation and deletion stop immediately, whatever the state. The UI warns when it's working.
* Cap: when `running ≥ MAX_RUNNING_WORKSPACES` on start, the gateway evicts the longest-idle ready workspace
  that has been idle for more than 5 min and isn't busy (`stopReason: "capacity"`). If there is none, the start
  fails with 409 `capacity`.

## Web app pages

| Route | Who | Purpose |
|---|---|---|
| `/login` | anyone | Username + password. A username locks for 15 min after 5 failures in 15 min. `?working=1` explains a deferred stop |
| `/` (Home) | signed in | The workspace card: harness and version; stopped, the kind to start as two radio cards, Private and Online, each with a line on what it allows (Online chosen by default; disabled, with the reason, when `online` isn't `allowed`), and "Start Online" / "Start Private", which opens that kind's confirmation ("Use Private" / "Use Online" flips it); running, the kind's badge, Stop and Open workspace; why it stopped or was refused (`kind_mismatch`, `online_disabled`, `online_not_allowed`, `capacity`); the idle rule. Then the user's LLM usage today (`llm_usage`). Polls every 2 s while something changes, else every 5 s |
| `/workspace` | signed in | Slim top bar (status pill, the kind's badge, "Admin connected", Stop, menu with the harness and the portal's pages) + iframe on the running kind's port (`workspaceFrame(session, kind)`: Private `:AGENT_PORT_BASE+target.id`, Online `:ONLINE_AGENT_PORT_BASE+target.id`). Nothing starts by itself: a stopped workspace shows the same kind choice and Start with the same confirmation. Stop always asks first, saying when the agent is working, the workspace is open elsewhere or an admin is in it (`web/lib/workspace-stop.ts`), then goes to `/` |
| `/settings` | signed in | Account (username, role and the dark / light theme; the names, with Save, audited `user_updated`), Harness (radio cards, saved at once; "Restart now", the same kind again after a confirmation, when the running one differs), Password (`#password`); for the admin, Electricity price (`#electricity`: the place, saved on change, with its latest price and source; a place with no prices stored yet asks the gateway to download them). Nothing about Private / Online |
| `/change-password` | signed in | Only the forced change (`must_change_password`); otherwise redirects to `/settings#password` |
| `/admin` (Usage) | admin | Live (GET `/api/admin/live`, frames every 500 ms while the tab is visible): LLM sessions with total Read and Write tok/s (each charted over the last minute, stacked on one time axis) and the workspace sessions table (8 a page, the running ones first: user and kind, live status or start and length, requests, Read and Write tok/s, tokens in and out, LLM time, energy with the average draw, cost; GET `/api/admin/llm-sessions?page=` on paging and when the frame's `sessionsVersion` changes); the LLM server and portal server cards (power draw, CPU, GPU, memory with free GiB and %, network, disks, fans). The sessions span the width over the two servers; from 1800 px wide the page grows into the margins and the three sit side by side |
| `/admin/energy` | admin | Both servers' energy per day (the servers' own sensors, not the wall): today and the month so far with their cost, the month's days as bars and as a table (kWh per server, price, cost); the month picker in the heading. GET `/api/admin/energy` every 60 s while visible and on a change of month |
| `/admin/users` | admin | Users table: role, account, the harness (the running agent and version, or the one the next Start launches), last sign-in, Open workspace and the actions menu (Stop workspace among them). Under it the running workspaces: user, kind, harness, status (Starting, Working with why, Idle for how long, Stopping, Error with the reason), memory, LLM requests, viewers, up for, Open workspace. Both from GET `/api/admin/overview` every 5 s |
| `/admin/users/new` | admin | Names, username, temporary password and the "Online workspace" permission (on by default; `users.online_allowed`, in `user_created`'s details) |
| `/admin/users/[id]` | admin | Pills (role, account, workspace status, the running kind, harness), Open workspace / Stop; Profile (names); Workspaces: the "Online workspace" switch (`setOnlineAccess`, audited `user_online_access_changed {allowed}`; off while their Online workspace starts or runs confirms, then stops it) and "Erase Private files…" / "Erase Online files…" (`eraseWorkspaceFiles` → `DELETE /control/workspaces/:id/files?kind=`, which the gateway audits; unavailable while that kind starts, runs or stops); Account (reset password, deactivate, delete) |
| `/admin/users/[id]/workspace` | admin | Red banner "Viewing <name>'s workspace · Exit" + iframe on that user's port for the running kind. A stopped workspace shows the kind choice (the user's own Online access) and Start with the confirmation (the user's harness); there is no Stop here (the users table has it) |
| `/admin/updates` | admin | The LLM engine, Qwen Code and DeepSeek Harness, one card each built the same way: name, source, status and the current version, with "Update to X.Y.Z" when latest is newer; the running job inline (stage, log, Cancel, and "Restart now" while the engine drains); then one folded Package images table (the offered versions: badges, release date, image on the server or to build/download first, workspaces using it, and Release notes, Switch/Use/Build/Rebuild, Remove). See Agent versions and updates, and LLM engine updates. `/admin/agents` redirects here |
| `/admin/audit` | admin | Audit log |

The admin pages read the gateway on the server and then follow admin-only routes for live data:
`GET /api/admin/live` (Usage: the gateway's `/control/live` event stream passed through; the session is
checked again every 30 s and the stream ends when it no longer holds), `GET /api/admin/overview` (the users
table and the running workspaces, every 5 s), `GET /api/admin/llm-sessions` (Usage's sessions table, a page),
`GET /api/admin/energy` (Energy), `GET /api/admin/agents` and `GET /api/admin/engine` (the Updates page). "Check for updates"
is a POST to those two, which asks the gateway with `refresh=1` (the registries again, not the cache); a POST so
that it gets the same-origin check of the state-changing routes, and a workspace page the admin has open can't
make the server query a registry in a loop. The Updates page polls every second while a job runs, else less
often, and at once after each action. Its actions are server actions (`web/lib/actions/agents.ts`,
`web/lib/actions/engine.ts`) that pass the admin as `actorUserId`; removing an image audits
`agent_image_removed` / `engine_image_removed` in the web app (the gateway audits the updates).

The theme is the `portal_theme` cookie (`dark`, the default, or `light`), read by the root layout so the first
paint is right; the Qwen Code iframe gets it as `?theme=` (DeepSeek Harness has no theme parameter).

**Ending a session** always has two halves (`endSessionsInBackground` in `web/lib/gateway.ts`): deleting the
row stops new requests, and after the response the web app calls `disconnect` for each deleted session (its
open terminals and streams would stay up otherwise) and `release` for each workspace those sessions used.

* Login:
  1. Housekeeping: delete stale `login_attempts` rows, and end expired sessions.
  2. `reserveLoginAttempt`, in one IMMEDIATE transaction before argon2: refuse a locked username, or else count
     the attempt as a failure up front, so parallel guesses can't outrun the lock. A correct password clears
     the record.
  3. Verify (argon2id; a dummy verification for unknown usernames).
  4. End the session this browser's cookie still names, if any (an admin's open view of someone's workspace
     is audited as left with reason `signed_out`). Create the new session.
  5. Attach to the workspace (`attachWorkspaceInBackground`): if it is starting or running, `POST
     /control/workspaces/:id/attach`, which only calls off a pending stop and never starts anything. A stopped
     workspace waits for the user's Start. Then redirect to `/change-password` if required, else `/`.
* Sign out: end the session, clear the cookie, and redirect to `/login`, with `?working=1` when the workspace
  stays up to finish its work.
* Change password: end the account's other sessions; this one carries on.
* Admin "Open workspace": set `acting_as_user_id`, write the audit entry, `disconnect` this session (its old
  token dies with the target change), attach to the target's workspace as at sign-in (a stopped one waits for
  the admin's Start), then redirect.
* Start and Stop: Start is `POST /api/workspace/start` with `{ kind: "private" | "online" }`, required (400
  `invalid_kind` without it: nothing starts without the person's choice and confirmation); the gateway launches
  that kind with the user's harness (users.agent while enabled, else the first enabled agent), or refuses with
  `kind_mismatch`, `online_disabled`, `online_not_allowed` or `capacity`. Stop is `POST /api/workspace/stop` (reason `user`,
  403 while an admin views someone else's workspace). Saving a harness in Settings (`saveHarness`) writes
  `users.agent` and audits `agent_preference_changed {from, to}`; a running workspace keeps its agent until
  "Restart now" (`restartWorkspace`: stop, then start) or its next start. The `/api/workspace/*` routes check
  same-origin and the session, and answer with the workspace's state, whose workspace it is, the enabled agents
  and `nextAgent` (what the next Start launches); `kind` and `online` come with the workspace's state.
* Leaving a viewed workspace (`leaveViewedWorkspace`): clear `acting_as_user_id`, audit
  `admin_exited_workspace`, `disconnect`, `release` the target. It runs on "Exit", on "My workspace" in the admin
  header, and when the admin opens their own workspace from the dashboard or their user page (audit reason
  `switched`).
* Deactivate / reset password: end the user's sessions (deactivate also `stop`s the workspace).
* Delete user: deactivate the account and end its sessions, then `DELETE /control/workspaces/:id/data` (it stops
  the workspace), then audit and delete the row. If the data can't be deleted, the account stays, deactivated.

The web container runs as uid/gid 10001 with a root-owned, read-only app; it writes only to `db/`. It refuses to
start without a `GATEWAY_CONTROL_SECRET` of at least 16 characters.
* The iframe's port and token are computed server-side (`workspace-frame.ts`: `agentPortFor`,
  `agentBrowserToken`); the page builds the URL for the running agent (`agent-url.ts`): Qwen Code gets
  `/?theme=dark#token=…`, DeepSeek Harness `/` with no token. If the user id doesn't fit the port range,
  the page says so instead.
