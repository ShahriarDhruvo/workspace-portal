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
           wp-ws-1               wp-ws-2        …       wp-ws-N      (qwen serve :4170, uid 200000+N)
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
| `QWEN_CODE_VERSION` | `0.27.0` | compose, deploy scripts | Selects the per-user image `workspace-portal/workspace:qwen-<version>`, built from `workspace-image/`. Compose passes it to the gateway as `WORKSPACE_IMAGE` |
| `WORKSPACE_NETWORK` / `_SUBNET` / `_GATEWAY_IP` / `_IP_RANGE` / `_BRIDGE` | `workspace-portal-ws` / `172.29.0.0/16` / `172.29.0.1` / `172.29.128.0/17` / `br-wportal` | gateway, firewall | The gateway creates the network at startup |
| `WORKSPACE_UID_BASE` | `200000` | gateway | User N's workspace runs as uid/gid `base + N` |
| `WORKSPACE_MEMORY` / `_CPUS` / `_PIDS` / `_SHM` / `_TMP` | `3g` / `4` / `1024` / `1g` / `1g` | gateway | Per-container limits; `_TMP` sizes the tmpfs `/tmp` |
| `WORKSPACE_BROWSER` | `true` | gateway | Adds the Playwright MCP server (headless Chromium in the workspace) |
| `MAX_RUNNING_WORKSPACES` | `4` | gateway | Running-container cap |
| `IDLE_TIMEOUT_MINUTES` | `30` | both | Idle stop; also the approval timeout of `qwen serve` |
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
    home/                             200000+id 0700  → /home/user  (~/.qwen: chats, memory, user settings)
    workspace/                        200000+id 0700  → /workspace
    system/                           root 0755, rewritten at every start, mounted read-only:
      qwen/settings.json, qwen/system-defaults.json   → /etc/workspace-portal/qwen/
      passwd, group                                    → /etc/passwd, /etc/group
```

The installer labels the tree `container_file_t` (SELinux), so binds need no `:z`.

## Database (packages/db)

Schema: `packages/db/src/schema.ts` (Drizzle) plus `migrations.ts` (SQL, applied with `PRAGMA user_version`).
Open it only through `getDatabase(PORTAL_DATA_DIR + "/db/portal.sqlite")`. Both services call it at startup,
and migrations are safe to run concurrently.

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

## Workspace browser token

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

## Gateway control API (127.0.0.1:CONTROL_PORT)

Every request needs `Authorization: Bearer ${GATEWAY_CONTROL_SECRET}`. JSON in and out.
Errors: `{ "error": "<code>", "message": "<human text>" }` with a 4xx/5xx status.

```
GET  /control/health                         → { ok: true }
GET  /control/stats                          → HostStats
GET  /control/workspaces                     → { workspaces: WorkspaceInfo[] }   (every user that has a row)
GET  /control/workspaces/:userId             → WorkspaceInfo (status "stopped" if no row)
POST /control/workspaces/:userId/start       → WorkspaceInfo   409 {error:"capacity"} when the cap is reached and nothing can be evicted; 409 {error:"deleting"} while its data is being deleted
POST /control/workspaces/:userId/stop        → WorkspaceInfo   body { reason?: "admin" | "deactivated" | "deleted" (default "admin"), actorUserId?: number }; immediate, even while working
POST /control/workspaces/:userId/release     → WorkspaceInfo   no session uses it any more: stop now, or once the agent's work is done (stopPending)
POST /control/sessions/:sessionId/disconnect → { closed: number }  closes that session's open agent connections and presence
DELETE /control/workspaces/:userId/data      → { ok: true }    stops the container and deletes the user's data directory; 500 {error:"stop_failed"} (nothing deleted) if the container can't be removed
```

Start returns as soon as the container is created and started (`status: "starting"`, `ready: false`).
Qwen Code boots in the background (up to 90 s). The caller polls `GET /control/workspaces/:userId` until it
sees `status: "running"` with `ready: true`, or `status: "error"` with `lastError`. Starting an already
starting or running workspace returns its state and clears `stopPending`.

Other error codes:
* 400: `invalid_user_id`, `invalid_reason`, `invalid_actor`, `invalid_json`, `bad_request`.
* 404: `user_not_found`, `not_found`.
* 405: `method_not_allowed`.
* 401: `unauthorized`.
* 409: `capacity`, `deleting`.
* 500: `start_failed`, `stop_failed`, `internal`.

```ts
type WorkspaceInfo = {
  userId: number;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  ready: boolean;              // qwen serve answered /health?deep=1 with channelAlive
  startedAt: number | null;
  lastActivityAt: number | null;
  idleSeconds: number | null;  // null when not running; 0 while busy
  memoryBytes: number | null;
  connections: { owner: number; admin: number };  // sessions that have it open (streams, sockets, or a request in the last 20 s)
  llmInFlight: number;
  busy: boolean;               // the agent is working; never idle-stopped
  busyReason: "task" | "llm" | "cpu" | null;
  stopPending: boolean;        // nobody is signed in to it any more; it stops once the work is done
  stopReason: string | null;   // "logout" | "idle" | "admin" | "deactivated" | "deleted" | "capacity" | "error" | ...
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
gives every workspace its own browser origin. Origins matter because the Web Shell keeps state (prompt
history, its service worker, the token) per origin and runs same-origin scripts (`/mcp-app-sandbox`);
one shared origin would let one user's page read another's.

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
   "Admin connected"). An open Web Shell tab polls every few seconds.
5. **Blocked paths.** `/web-shell/pairing*` (device pairing would hand out the real token) gets 403.
   Paths under `/__portal/` are the gateway's own: `POST /__portal/start` is the "Try again" form.
6. **Token.** See "Workspace browser token"; a wrong one gets 401 `invalid_token`. WebSockets carry it as the subprotocol `qwen-bearer.<token>`
   next to `qwen-ws`. The relay strips it, opens the upstream socket with the real token in the
   Authorization header, and echoes the subprotocol the container selected.
7. **Not running.** Only a document navigation (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` when
   that header is missing) starts a workspace, and it gets a "Starting…" page that reloads every 2 s.
   * A cross-site navigation gets a Start button instead.
   * At the cap with nothing to evict: a capacity page.
   * After a failed start: an error page with `lastError`.
   * While the user's data is being deleted: a 503 page, and nothing starts.
   * Everything else, WebSockets included, gets a 503 `{error, message}` (`workspace_starting` with
     `Retry-After: 2`, `workspace_error`, `workspace_stopped`) and does **not** start it. An open tab's
     reconnect loop must not wake a stopped workspace.
8. **Forwarding.** Requests go to `http://<container ip>:4170`.
   * Cookie, Origin, Forwarded/X-Forwarded-* and Sec-Fetch-* are stripped, and Host is rewritten to the
     container address (`qwen serve` checks Host and Origin).
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
9. **Person activity** (`touch`): a document navigation, any non-GET/HEAD/OPTIONS request except
   `*/heartbeat`, or a WebSocket message from the browser. Polls, heartbeats, event streams and frames
   from the container don't count, so an open but unused tab lets the workspace go idle.
   `last_activity_at` is flushed to SQLite at most every 30 s.
10. WebSockets: only `/terminal`, `/acp` and `/live/web` (others 404). The relay pings the browser every
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

## Qwen Code settings rendering (`qwen.ts`)

At every start the gateway reads the admin's `config/qwen/settings.json` and `system-defaults.json`
(JSONC; a missing file counts as `{}`) and writes per-user copies into `users/<id>/system/qwen/`. The image
points `QWEN_CODE_SYSTEM_SETTINGS_PATH` and `QWEN_CODE_SYSTEM_DEFAULTS_PATH` at them. Qwen Code's precedence
is system-defaults < user < workspace < system.

* `system-defaults.json` is the admin's file, which must define at least one model under
  `modelProviders.openai` (otherwise the start fails with a `QwenConfigError`).
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
* A parse error is a `QwenConfigError`. It fails the start with a message naming the file, and is logged at
  gateway boot.

The container also gets `QWEN_USAGE_STATISTICS_ENABLED=false`. The image sets `QWEN_TELEMETRY_ENABLED=false`,
`DO_NOT_TRACK=1`, `NO_UPDATE_NOTIFIER=1` and npm's no-update-notifier/no-audit/no-fund flags.

## Workspace lifecycle

* Container `wp-ws-<id>`, with labels `workspace-portal.workspace=1` and `workspace-portal.user-id=<id>`,
  runs as `User <200000+id>:<200000+id>`.
* Mounts, per user only:
  * `users/<id>/home → /home/user` and `users/<id>/workspace → /workspace` (read-write);
  * `users/<id>/system/qwen → /etc/workspace-portal/qwen:ro`;
  * `system/passwd → /etc/passwd:ro` and `system/group → /etc/group:ro`.
* Hardening: `ReadonlyRootfs`, tmpfs `/tmp` (nosuid, nodev, `WORKSPACE_TMP`), `CapDrop: ALL`,
  `no-new-privileges`, memory (+512 MiB swap), CPU and PID limits, `ShmSize`, `OomScoreAdj 500`,
  `RestartPolicy: no`, and json-file logs capped at 10 MB × 3.
* Process: `tini` → `start-workspace` (it refuses to run as root) → `qwen serve --hostname <container ip>
  --port 4170 --workspace /workspace --permission-response-timeout-ms <idle timeout>`.
* Start:
  1. Prepare the directories (owner `200000+id`, mode 0700) and render the settings and passwd/group.
  2. Generate the token, remove any stale container, then create and start (`starting`).
  3. Poll `GET /health?deep=1` with the token every 500 ms (90 s timeout) until it answers 200 with
     `channelAlive` (`running`, `ready`).

  A failure or exit leads to `error` with `lastError` (including the last log lines), and the container
  is removed.
* A container that dies is noticed within 15 s or on the next failed proxy request. It becomes `stopped`
  with `stopReason: "error"`, audited as `workspace_error`.
* Stop: `stop -t 10`, then remove. Data stays in the bind mounts. If Docker fails to remove it, the
  container is kept as a leftover (its id stays in the row): reconcile retries the removal, and it is never
  adopted again. The same holds for the cleanup after a failed start and for rows found `stopping` at boot.
* Every Docker API call has a 60 s timeout.
* Gateway restart: workspace containers keep running. The next gateway adopts them (it reads the token back
  from the container's env) when it starts and every 5 min. Orphans are removed. A container IP claimed by a
  newer workspace is taken from the old entry, whose container is then checked.
* At boot the gateway exits unless the Docker Engine is 25.0.5 or newer (CVE-2024-29018: older engines
  forward DNS queries from internal networks), and it validates the Qwen Code settings.

### Busy and idle

Every 15 s the gateway samples each running workspace:

* **Agent state** from `GET /health?deep=1`. `task` means the agent is working: `activePrompts > 0`, or
  `activeWork` is true (tools, subagents, background shells, monitors; a stale report counts as working),
  or `pendingPermissions > 0`.
  * An approval waiting for an answer counts as work, connected or not. `qwen serve` declines one nobody
    answers after `IDLE_TIMEOUT_MINUTES` (`--permission-response-timeout-ms`), and the idle countdown starts then.
  * When the health check doesn't answer, the last known state stays and is marked unknown. The agent
    then counts as working for 5 min after the last answer (a busy `qwen serve` can be slow to reply),
    and as not working after that, so a broken `qwen serve` can't keep its workspace up.
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
| `/workspace` | signed in | Top bar (full name, workspace status, "Admin connected" pill, Sign out) + iframe on `:AGENT_PORT_BASE+target.id` |
| `/admin` | admin | Users table, host stats, workspace status (Working / Idle / Stopped, stop pending) and actions |
| `/admin/users/new`, `/admin/users/[id]` | admin | Create / edit (names, active, reset password, delete) |
| `/admin/users/[id]/workspace` | admin | Red banner "Viewing <name>'s workspace · Exit" + iframe on that user's port |
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
  5. Call `POST /control/workspaces/:id/start` (capacity errors are shown by the page), then redirect to
     `/change-password` if required, else `/workspace`.
* Sign out: end the session, clear the cookie, and redirect to `/login`, with `?working=1` when the workspace
  stays up to finish its work.
* Change password: end the account's other sessions; this one carries on.
* Admin "Open workspace": set `acting_as_user_id`, write the audit entry, `disconnect` this session (its old
  token dies with the target change), `start` the target, then redirect.
* Leaving a viewed workspace (`leaveViewedWorkspace`): clear `acting_as_user_id`, audit
  `admin_exited_workspace`, `disconnect`, `release` the target. It runs on "Exit", on "My workspace" in the admin
  header, and when the admin opens their own workspace from the dashboard or their user page (audit reason
  `switched`).
* Deactivate / reset password: end the user's sessions (deactivate also `stop`s the workspace).
* Delete user: deactivate the account and end its sessions, then `DELETE /control/workspaces/:id/data` (it stops
  the workspace), then audit and delete the row. If the data can't be deleted, the account stays, deactivated.

The web container runs as uid/gid 10001 with a root-owned, read-only app; it writes only to `db/`. It refuses to
start without a `GATEWAY_CONTROL_SECRET` of at least 16 characters.
* The iframe URL is built server-side (`workspace-frame.ts`): the port comes from `agentPortFor`, the token
  from `agentBrowserToken`. If the user id doesn't fit the port range, the page says so instead.
