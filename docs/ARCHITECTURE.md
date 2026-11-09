# Workspace Portal: architecture and contracts

This is the single source of truth for how the pieces fit together. Code must follow it. If
something here turns out to be wrong, fix this file in the same change.

## Components

```
Browser ──▶ :3000            web (Next.js)       sign-in, change password, admin, /workspace (top bar + iframe)
Browser ──▶ :3100+N          gateway agent port  user N's workspace: session check → HTTP/WebSocket proxy to wp-ws-N
                             gateway 127.0.0.1:4002   control API, called by web only
                             gateway 172.29.0.1:4001  service API (LLM proxy + search MCP), called by workspaces only
                                    │ Docker API (/var/run/docker.sock)
              ┌─────────────────────┼─────────────────────┐
           wp-ws-1               wp-ws-2        …       wp-ws-N      (one agent each: qwen serve :4170 or dsh :3080, uid 200000+N)
              └── network "workspace-portal-ws" 172.29.0.0/16, bridge br-wportal, internal, ICC off ──┘
```

* `web` and `gateway` run with `network_mode: host` and share one SQLite file.
  * `web` runs as uid 10001 and can see only the `db/` directory.
  * `gateway` runs as root inside its container, with only CHOWN, DAC_OVERRIDE and FOWNER. It creates each
    user's directories, owned by that user's workspace UID, and drives the Docker socket.
* Workspaces live on the `workspace-portal-ws` network.
  * Docker creates it `Internal` (no default route, no NAT, no DNS for outside names). ICC and IPv6 are off.
  * The host firewall (`deploy/firewall.sh`, nftables table `inet workspace_portal`, applied by
    `workspace-portal-firewall.service` before docker.service) admits only new connections to
    `172.29.0.1:SERVICE_PORT` from the bridge or subnet, and drops all forwarding from or to them. Its input
    chain runs at priority `filter - 10`, before firewalld's and Docker's chains; a drop there is final.
  * The gateway checks every attribute of an existing network with that name: internal, IPv6 off, bridge
    name, ICC off, masquerade off, and exactly one IPAM pool with the configured subnet, gateway and IP
    range. A network that differs is replaced when no container uses it; otherwise the gateway refuses to
    start and lists the differences.
* The LLM server and SearXNG are external; on the test server they are `127.0.0.1:8080` and `127.0.0.1:8888`.
  Only the gateway talks to them.

## Ports and env

All config comes from `.env` at the repo root (documented line by line in `.env.example`).
`docker-compose.yml` passes each service only the variables listed for it below, so web never sees the LLM or
SearXNG credentials and the gateway never sees `ADMIN_PASSWORD`. An empty value means the default. The deploy
scripts read `.env` through `deploy/lib.sh` (`env_get`), falling back to `.env.example`.

| Var | Default | Used by | Meaning |
|---|---|---|---|
| `PORTAL_DATA_DIR` | `/srv/workspace-portal` | both | Host path; mounted at the same path inside the containers |
| `WEB_BIND` / `WEB_PORT` | `0.0.0.0` / `3000` | web | Portal UI |
| `AGENT_BIND` / `AGENT_PORT_BASE` / `AGENT_PORT_COUNT` | `0.0.0.0` / `3100` / `200` | gateway, web | User N (1 ≤ N < count) is served on `base + N`. Web builds the iframe URL from it |
| `CONTROL_PORT` | `4002` | both | Gateway control API on 127.0.0.1 |
| `SERVICE_PORT` | `4001` | gateway, firewall | Service API on `WORKSPACE_GATEWAY_IP` |
| `GATEWAY_CONTROL_SECRET` | random | both | Bearer token of the control API; also the HMAC key of workspace browser tokens |
| `SESSION_COOKIE_SECURE`, `SESSION_TTL_HOURS` | `false`, `168` | web | Cookie `Secure` flag; sliding session lifetime |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_*_NAME` | | web | Seeds the single admin on first start if no admin exists, with `must_change_password` set |
| `LLM_UPSTREAM_URL` | `http://127.0.0.1:8080` | gateway | OpenAI-compatible server root; the proxy appends `/v1/...` |
| `LLM_API_KEY` | empty | gateway | Sent upstream as `Authorization: Bearer` if set |
| `LLM_MAX_CONCURRENCY` / `LLM_MAX_CONCURRENCY_PER_USER` | `3` / `2` | gateway | LLM queue limits |
| `SEARXNG_URL`, `SEARXNG_AUTHORIZATION`, `SEARXNG_TIMEOUT_SECONDS` | `http://127.0.0.1:8888`, empty, `20` | gateway | SearXNG backend of the search MCP |
| `SEARCH_MAX_CONCURRENT_PER_USER` | `2` | gateway | Concurrent searches per workspace |
| `WORKSPACE_AGENTS` | `qwen,dsh` | gateway, deploy scripts | The agents users choose from when their workspace starts (`qwen` Qwen Code, `dsh` DeepSeek Harness), in display order. With one, it starts without asking |
| `QWEN_CODE_VERSION` / `DSH_VERSION` | `0.27.0` / `0.2.2-rc.1` | gateway, deploy scripts | Select the per-user images `workspace-portal/workspace:qwen-<version>` and `:dsh-<version>`, built from the `qwen` and `dsh` targets of `workspace-image/Dockerfile` |
| `WORKSPACE_NETWORK` / `_SUBNET` / `_GATEWAY_IP` / `_IP_RANGE` / `_BRIDGE` | `workspace-portal-ws` / `172.29.0.0/16` / `172.29.0.1` / `172.29.128.0/17` / `br-wportal` | gateway, firewall | The gateway creates the network at startup |
| `WORKSPACE_UID_BASE` | `200000` | gateway | User N's workspace runs as uid/gid `base + N` |
| `WORKSPACE_MEMORY` / `_CPUS` / `_PIDS` / `_SHM` / `_TMP` | `3g` / `4` / `1024` / `1g` / `1g` | gateway | Per-container limits; `_TMP` sizes the tmpfs `/tmp` |
| `WORKSPACE_BROWSER` | `true` | gateway | Adds the Playwright MCP server (headless Chromium in the workspace) |
| `MAX_RUNNING_WORKSPACES` | `4` | gateway | Running-container cap |
| `IDLE_TIMEOUT_MINUTES` | `30` | both | Idle stop; also the approval timeout of `qwen serve` (dsh has none: see Busy and idle) |
| `MAX_BUSY_HOURS` | `24` | gateway | Work stops counting as activity this long after a person last used the workspace (0 = never) |
| `UPLOAD_LIMIT_MB` | `100` | gateway | Max request body through the agent proxy |
| `FIREWALL_ALLOW_SOURCE` | detected | installer | Sources allowed to reach `WEB_PORT` and the agent ports in firewalld/ufw: default the LAN of the default route, plus `100.64.0.0/10` when `tailscale0` exists |

Config validation: the agent port range must end below 65536, and `WEB_PORT`, `CONTROL_PORT` and
`SERVICE_PORT` must lie outside it.

## Data directory

```
PORTAL_DATA_DIR/                      root 0755
  db/portal.sqlite (+ -wal, -shm)     10001 (web); the gateway hands files it creates to the dir's owner
  config/qwen/                        root 0700 (files 0600): the admin's settings.json, system-defaults.json
  users/<id>/                         root 0711
    home/                             200000+id 0700  → /home/user, shared by both agents:
                                        ~/.qwen (Qwen Code: chats, memory, user settings),
                                        ~/.dsh and ~/.agents (DeepSeek Harness: sessions, settings, skills), caches
    workspace/                        200000+id 0700  → /workspace, shared by both agents
    system/                           root 0755, rewritten at every start, mounted read-only:
      qwen/settings.json, qwen/system-defaults.json   → /etc/workspace-portal/qwen/   (Qwen Code starts)
      dsh/portal.patch.yml                             → /etc/workspace-portal/dsh/    (DeepSeek Harness starts)
      passwd, group                                    → /etc/passwd, /etc/group
```

The installer labels the tree `container_file_t` (SELinux), so binds need no `:z`.

## Database (packages/db)

Schema: `packages/db/src/schema.ts` (Drizzle) plus `migrations.ts` (SQL, applied with `PRAGMA user_version`).
Open it only through `getDatabase(PORTAL_DATA_DIR + "/db/portal.sqlite")`. Both services call it at startup,
and migrations are safe to run concurrently.

`workspaces.agent` (migration 2) is the agent of the current or last run (`qwen` | `dsh`, null before the
first start). A container started before agents existed has no agent label and counts as `qwen`.

Ownership:
* web writes `users`, `sessions`, `login_attempts`, and `audit_log` (user and admin actions).
* gateway writes `workspaces`, `llm_usage`, and `audit_log` (`workspace_started`, `workspace_stopped`,
  `workspace_error`). The audit `actorUserId` is the one given to `/stop`; otherwise it is null.
* gateway only reads `users` and `sessions` (`loadSessionContext`, `countSessionsUsingWorkspace`).

## Sessions and cookies

* Cookie `portal_session` holds a random token. The DB stores `hashSessionToken(token)` as `sessions.id`.
* Attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>`, plus `Secure` when `SESSION_COOKIE_SECURE=true`.
  There is no `Domain` attribute.
  * Cookies ignore ports, so the gateway's agent ports receive it.
  * The page on :3000 and the iframe on :3100+N are same-site, so the cookie is sent inside the iframe.
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
agentBrowserToken(GATEWAY_CONTROL_SECRET, sessions.id, target.id)
  = base64url(HMAC-SHA256(secret, "workspace-portal/agent-token/v1\n" + sessionId + "\n" + userId))
```

* web puts it in the iframe URL fragment: `http://<host>:<base+N>/?theme=dark#token=<t>`. The Web Shell
  moves it to `sessionStorage`. A fragment is never sent to a server and doesn't appear in referrers.
* The gateway recomputes it for the request's session and port user and compares in constant time.
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
GET  /control/agents                         → { agents: AgentInfo[] }   (the enabled agents, in WORKSPACE_AGENTS order)
GET  /control/workspaces                     → { workspaces: WorkspaceInfo[] }   (every user that has a row)
GET  /control/workspaces/:userId             → WorkspaceInfo (status "stopped" if no row)
POST /control/workspaces/:userId/start       → WorkspaceInfo   body { agent?: AgentKind } (or none); see below
POST /control/workspaces/:userId/stop        → WorkspaceInfo   body { reason?: "admin" | "user" | "deactivated" | "deleted" (default "admin"), actorUserId?: number }; immediate, even while working
POST /control/workspaces/:userId/release     → WorkspaceInfo   no session uses it any more: stop now, or once the agent's work is done (stopPending)
POST /control/sessions/:sessionId/disconnect → { closed: number }  closes that session's open agent connections and presence
DELETE /control/workspaces/:userId/data      → { ok: true }    stops the container and deletes the user's data directory; 500 {error:"stop_failed"} (nothing deleted) if the container can't be removed
```

**One agent at a time.** A workspace runs one agent (one container), chosen when it starts:

* Stopped or error: start `agent`; without one, the agent it ran last; without that, the only enabled
  agent; with several and no history, 400 `agent_required` (the user chooses in the portal).
* Starting or running: with the same agent or none named, its state is returned and `stopPending`
  cleared. Naming the other agent is 409 `agent_mismatch` ("<name> is already running in this workspace.
  Stop it to switch."). Switching means stopping first (the user's own stop has reason `user`).
* 400 `unknown_agent` (not an agent kind), 400 `agent_unavailable` (not in `WORKSPACE_AGENTS`, also
  when that is the last-used one), 409 `capacity` (the cap is reached and nothing can be evicted),
  409 `deleting` (its data is being deleted).

Start returns as soon as the container is created and started (`status: "starting"`, `ready: false`).
The agent boots in the background (up to 90 s). The caller polls `GET /control/workspaces/:userId` until
it sees `status: "running"` with `ready: true`, or `status: "error"` with `lastError`.

Other error codes:
* 400: `invalid_user_id`, `invalid_reason`, `invalid_actor`, `invalid_json`, `bad_request`, `agent_required`,
  `unknown_agent`, `agent_unavailable`.
* 404: `user_not_found`, `not_found`.
* 405: `method_not_allowed`.
* 401: `unauthorized`.
* 409: `capacity`, `deleting`, `agent_mismatch`.
* 500: `start_failed`, `stop_failed`, `internal`.

```ts
type AgentKind = "qwen" | "dsh";   // @portal/db AGENT_KINDS; display names in AGENT_NAMES
type AgentInfo = { id: AgentKind; name: string; description: string; version: string };
type WorkspaceInfo = {
  userId: number;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  agent: AgentKind | null;     // the agent of the container; when stopped, the one it ran last; null if never started
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
  stopReason: string | null;   // "logout" | "idle" | "admin" | "user" | "deactivated" | "deleted" | "capacity" | "error" | ...
  lastError: string | null;
};
type HostStats = {
  running: number; maxRunning: number; idleTimeoutMinutes: number;
  memTotalBytes: number; memAvailableBytes: number; loadAvg: [number, number, number]; cpus: number;
  llm: { inFlight: number; queued: number; maxConcurrency: number };
};
```

## Agent ports (AGENT_BIND:AGENT_PORT_BASE+1 … +COUNT-1)

The gateway listens on every port in the range. The port says whose workspace a request is for, and it
gives every workspace its own browser origin. Origins matter because the agents' UIs keep state (prompt
history, service workers, the Web Shell's token) per origin and run same-origin scripts (the Web Shell's
`/mcp-app-sandbox`); one shared origin would let one user's page read another's.

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
   (403 `forbidden_cross_site`).
2. **Session.** Read `portal_session` and call `loadSessionContext`. With no valid session, navigations get
   the themed "You're signed out" page linking to `//<host>:WEB_PORT/login`; everything else gets 401
   `unauthenticated`.
3. **Port user.** `target.id` must equal the port's user. Otherwise navigations get "This workspace isn't
   open here" with a link back to the portal, and everything else gets 403 `other_workspace`. An admin
   reaches user N's port only after "Open workspace" set `acting_as_user_id = N`.
4. **Presence.** The request marks this session as having the workspace open for 20 s (`connections`,
   "Admin connected"). An open Web Shell tab polls every few seconds; an open dsh tab keeps its
   `/api/remote.mux` socket, which counts as open for as long as it lasts.
5. **Blocked paths.** The agent's blocked prefixes (table above; matched on the canonical, lowercased
   path, so no spelling gets around them) get 403 `not_available`: device pairing and launch-token
   exchange would hand out access to the container, the rest needs the internet. Paths under `/__portal/`
   are the gateway's own: `POST /__portal/start` is the "Try again" form.
6. **Token** (token agents). See "Agent credentials and browser auth". Any token the browser presents
   must be this session's token for this port's workspace, whatever the agent: a wrong one gets 401
   `invalid_token` before anything else. WebSockets carry it as the subprotocol `qwen-bearer.<token>`
   next to `qwen-ws`. The relay strips it, opens the upstream socket with the real token in the
   Authorization header, and echoes the subprotocol the container selected. A cookie agent gets the
   minted cookie on every request and upgrade instead.
7. **Not running.** Only a document navigation (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` when
   that header is missing) starts a workspace, and it gets a "Starting…" page that reloads every 2 s.
   * A cross-site navigation gets a Start button instead.
   * At the cap with nothing to evict: a capacity page.
   * After a failed start: an error page with `lastError`.
   * While the user's data is being deleted: a 503 page, and nothing starts.
   * Everything else, WebSockets included, gets a 503 `{error, message}` (`workspace_starting` with
     `Retry-After: 2`, `workspace_error`, `workspace_stopped`) and does **not** start it. An open tab's
     reconnect loop must not wake a stopped workspace.
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

## Service API (WORKSPACE_GATEWAY_IP:SERVICE_PORT), for workspace containers

The caller is identified by source IP: the gateway maps each running workspace's container IP to its
userId. Unknown sources get 403. Containers have no capabilities and inter-container traffic is off, so
they can't spoof an address.

```
POST /llm/v1/chat/completions, /llm/v1/completions, /llm/v1/embeddings  → LLM_UPSTREAM_URL/v1/…  streaming pass-through
GET  /llm/v1/models, /llm/v1/models/<id>                                → LLM_UPSTREAM_URL/v1/…
POST /mcp/search                                                         → built-in MCP server (streamable HTTP, stateless)
```

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
  * MCP protocol versions are 2025-11-25 back to 2024-11-05. The server offers one tool, `web_search`
    (`query`, `page`, `time_range`, `language`).
  * Each call queries `SEARXNG_URL/search?format=json`, adding `SEARXNG_AUTHORIZATION`, with
    `SEARXNG_TIMEOUT_SECONDS` and a per-workspace concurrency limit.
  * Results are text: up to 10 results, each with a title, URL and a snippet cut to 500 characters. No page
    is ever fetched for the workspace.
  * A call counts as agent activity.

## Agent settings rendering

At every start the gateway renders the settings of the agent being started (`driver.renderSettings`) into
`users/<id>/system/<agent>/` and mounts that directory read-only at the agent's settings path. Unusable
admin settings throw `AgentConfigError`: the start fails with its message, and the gateway logs it at boot
for every enabled agent. The admin configures both agents through Qwen Code's two files; DeepSeek Harness
takes only the model list from them.

### Qwen Code (`agents/qwen-settings.ts`)

At every Qwen Code start the gateway reads the admin's `config/qwen/settings.json` and `system-defaults.json`
(JSONC; a missing file counts as `{}`) and writes per-user copies into `users/<id>/system/qwen/`. The image
points `QWEN_CODE_SYSTEM_SETTINGS_PATH` and `QWEN_CODE_SYSTEM_DEFAULTS_PATH` at them. Qwen Code's precedence
is system-defaults < user < workspace < system.

* `system-defaults.json` is the admin's file, which must define at least one model under
  `modelProviders.openai` (otherwise the start fails with an `AgentConfigError`).
  * Only `modelProviders.openai` survives.
  * Every entry gets `baseUrl = http://WORKSPACE_GATEWAY_IP:SERVICE_PORT/llm/v1` and `envKey = PORTAL_LLM_KEY`,
    and loses `apiKey`.
  * `security.auth.selectedType` is set to `openai`.
* `settings.json` is the admin's file plus forced keys.
  * Turned off: `general.enableAutoUpdate`, `general.preventSystemSleep`, `privacy.usageStatisticsEnabled`,
    `telemetry.enabled` and `telemetry.logPrompts`, `model.catalogRefresh`.
  * `security.auth.enforcedType` and `selectedType` are set to `openai`. `permissions.deny` gains
    `web_fetch`. `tools.webSearch` is removed.
  * `mcpServers.search` is set to `{httpUrl: <service>/mcp/search, includeTools: ["web_search"], trust: true}`.
  * With `WORKSPACE_BROWSER=true`, `mcpServers.browser` runs `playwright-mcp --headless --isolated
    --no-sandbox` with the image's Chromium and output in `/workspace/.browser`. Otherwise
    `mcpServers.browser` is removed.
* Merging is deep for objects; arrays are replaced, and `__proto__`/`constructor`/`prototype` keys are ignored.
* A parse error is an `AgentConfigError` naming the file.

The container also gets `QWEN_USAGE_STATISTICS_ENABLED=false` and `QWEN_PERMISSION_TIMEOUT_MS` (the idle
timeout). The image sets `QWEN_TELEMETRY_ENABLED=false`, `DO_NOT_TRACK=1`, `NO_UPDATE_NOTIFIER=1` and npm's
no-update-notifier/no-audit/no-fund flags.

### DeepSeek Harness (`agents/models.ts`, `agents/dsh-settings.ts`)

`start-dsh` runs `dsh --profile web --patch <lockdown> --patch <portal>`. Patches apply after the user's
own `~/.dsh/profiles/web/cordis.patch.yml` (where the UI saves settings), so neither can be overridden from
the UI, which shows those plugins read-only.

* **Lockdown** (static, in the image: `workspace-image/dsh/lockdown.patch.yml` →
  `/usr/local/share/workspace-portal/dsh/lockdown.patch.yml`). Version-specific; check it on every dsh upgrade.
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
  * The presets that need the disabled tools are off, and `preset-standard` is restated without them.
* **Portal patch** (rendered per start: `users/<id>/system/dsh/portal.patch.yml` →
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

* Container `wp-ws-<id>`, with labels `workspace-portal.workspace=1`, `workspace-portal.user-id=<id>` and
  `workspace-portal.agent=<qwen|dsh>`, runs as `User <200000+id>:<200000+id>` from
  `workspace-portal/workspace:<agent>-<version>`. One per user, whichever agent; the container spec
  (`container-spec.ts`) is the same for both apart from the image, the env and the settings mount.
* Mounts, per user only:
  * `users/<id>/home → /home/user` and `users/<id>/workspace → /workspace` (read-write);
  * `users/<id>/system/<agent> → /etc/workspace-portal/<agent>:ro` (the running agent's only);
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
* Start (`POST /control/workspaces/:id/start`; which agent: see "One agent at a time"):
  1. Prepare the directories (owner `200000+id`, mode 0700) and render the agent's settings and passwd/group.
  2. Generate the credential, remove any stale container, then create and start (`starting`).
  3. Poll the driver's readiness probe every 500 ms (90 s timeout) until it passes (`running`, `ready`):
     Qwen Code `GET /health?deep=1` answering 200 with `channelAlive`; dsh its `session/list` RPC
     answering `ok` (not just any answer: its port returns 404 everywhere for a moment while it starts).

  A failure or exit leads to `error` with `lastError` (including the last log lines), and the container
  is removed.
* A container that dies is noticed within 15 s or on the next failed proxy request. It becomes `stopped`
  with `stopReason: "error"`, audited as `workspace_error`.
* Stop: `stop -t 10`, then remove. Data stays in the bind mounts. If Docker fails to remove it, the
  container is kept as a leftover (its id stays in the row): reconcile retries the removal, and it is never
  adopted again. The same holds for the cleanup after a failed start and for rows found `stopping` at boot.
* Every Docker API call has a 60 s timeout.
* Gateway restart: workspace containers keep running. The next gateway adopts them (it reads the agent from
  the label and the credential back from the container's env) when it starts and every 5 min. Orphans are removed. A container IP claimed by a
  newer workspace is taken from the old entry, whose container is then checked.
* At boot the gateway exits unless the Docker Engine is 25.0.5 or newer (CVE-2024-29018: older engines
  forward DNS queries from internal networks). It renders every enabled agent's settings and checks that its
  image exists, logging what is wrong (starts of that agent then fail with the message).

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
| `/change-password` | signed in | Forced when `must_change_password` |
| `/workspace` | signed in | Top bar (full name, workspace status, the running agent, "Switch agent" when more than one is enabled, "Admin connected" pill, Sign out) + iframe on `:AGENT_PORT_BASE+target.id`. Stopped or failed (with `lastError`): the agent chooser |
| `/admin` | admin | Users table, host stats, workspace status (Working / Idle / Stopped, stop pending), its agent ("last: …" when stopped) and actions |
| `/admin/users/new`, `/admin/users/[id]` | admin | Create / edit (names, active, reset password, delete); the user page shows the workspace's agent |
| `/admin/users/[id]/workspace` | admin | Red banner "Viewing <name>'s workspace · Exit" + iframe on that user's port; the agent chooser when that workspace is stopped |
| `/admin/audit` | admin | Audit log |

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
  5. Open the workspace (`openWorkspaceInBackground`, rules in `web/lib/agent-choice.ts`): if it is starting
     or running, attach to it (`start` without an agent, which also clears `stopPending`); if it is stopped and
     only one agent is enabled, start that one; otherwise start nothing, and the workspace page asks which agent
     to start. Then redirect to `/change-password` if required, else `/workspace`.
* Sign out: end the session, clear the cookie, and redirect to `/login`, with `?working=1` when the workspace
  stays up to finish its work.
* Change password: end the account's other sessions; this one carries on.
* Admin "Open workspace": set `acting_as_user_id`, write the audit entry, `disconnect` this session (its old
  token dies with the target change), open the target's workspace as at sign-in (a stopped one waits for the
  admin to choose its agent, preselecting the user's last one), then redirect.
* Choosing an agent and switching: the page calls `POST /api/workspace/start` with `{agent}`. "Switch agent"
  (own workspace only, when more than one agent is enabled) warns when the agent is working or the workspace is
  open elsewhere, then calls `POST /api/workspace/stop` (reason `user`, 403 while an admin views someone else's
  workspace) and shows the chooser. A 409 `agent_mismatch` (another tab chose differently) shows the gateway's
  message and attaches to what runs. The `/api/workspace/*` routes check same-origin and the session, and
  answer with the workspace's state, whose workspace it is, and the enabled agents.
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
