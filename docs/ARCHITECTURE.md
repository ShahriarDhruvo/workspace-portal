# Workspace Portal: architecture

For maintainers: the contracts between the parts, and the reasons behind decisions the code does not show.
Operation is in the [README](../README.md), every setting in [`.env.example`](../.env.example), portal-hostd
in [hostd/README.md](../hostd/README.md). A value that may change is named by the file that holds it.

## Components and trust boundaries

```
browser --(cookie portal_session)--> web app   WEB_BIND:WEB_PORT  <--(API key)-- other software
   |                                    |
   |                                    | Bearer GATEWAY_CONTROL_SECRET; under /llm/api the caller's API key
   |                                    v
   |                                 gateway   127.0.0.1:CONTROL_PORT       control API, LLM API
   +--(same cookie)----------------> gateway   AGENT_BIND: agent ports      one per user, agent and kind
   +--(same cookie)----------------> gateway   AGENT_BIND: preview ports    agent port + 10000
                                       |  ^
       container address, agent port,  |  |  <kind's gateway IP>:SERVICE_PORT    service API;
       the credential of this start    v  |  the caller is known by its source address
                                 workspace container (Private or Online network)
```

| The gateway also calls | At | With |
|---|---|---|
| Docker | `/var/run/docker.sock` | root in its container, with `CHOWN`, `DAC_OVERRIDE`, `FOWNER` only |
| the LLM server | `LLM_UPSTREAM_URL` | `LLM_API_KEY` |
| SearXNG, the page reader | `SEARXNG_URL`, `READER_URL` (loopback by default) | nothing, or `SEARXNG_AUTHORIZATION` |
| Exa, when `EXA_SEARCH` is on | `https://mcp.exa.ai/mcp` | nothing: no account, no key |
| portal-hostd on both servers | `HOSTD_PORTAL_URL`, `HOSTD_LLM_URL` | `HOSTD_PORTAL_TOKEN`, `HOSTD_LLM_TOKEN` |
| npm, GitHub, the engine's image registry, EIA, Eurostat | the internet | nothing |

- The web app holds the sessions and never touches Docker: its container runs as UID 10001 and mounts only
  `db/`. Everything it does to a workspace goes through the control API.
- The gateway alone holds the Docker socket, `LLM_API_KEY` and the hostd tokens. It needs root to hand each
  workspace's files to that workspace's UID, and `label=disable` because SELinux denies the socket to confined
  containers. Like the web app it runs in the host's network namespace.
- `GATEWAY_CONTROL_SECRET` is the control API's bearer token and the HMAC key of the browser tokens. The web
  app and the gateway both refuse to start with one shorter than 16 characters.
- An API key is a user's credential for the LLM and nothing else. The web app passes `/llm/api` on unread and
  the gateway checks the key, so the web app never vouches for such a caller with the control secret.
- A workspace is untrusted. It holds no secret of the portal (`PORTAL_LLM_KEY` in it is a placeholder), and
  what it sends is hostile input. So is what SearXNG, Exa and the page reader bring back from the internet.

## Repository map

| Path | Responsibility |
|---|---|
| `packages/core/` | `@portal/core`: schema, migrations, database opening, sessions, audit, browser token, wire contract |
| `gateway/src/main.ts` | the process: Docker checks, networks, listeners, shutdown |
| `gateway/src/compose.ts` | composition root: builds every part once, for `main.ts` and the test harness; starts nothing |
| `gateway/src/config.ts` | the environment, parsed and checked once (`loadConfig`); every problem reported together |
| `gateway/src/control-api.ts` | the control listener: the control API's routes, and the LLM API beside them |
| `gateway/src/workspaces/` | lifecycle (`manager.ts`), its pure decisions (`policy.ts`), file layout, readiness, fence probe |
| `gateway/src/docker/` | the Docker runtime, a workspace's container from the security profile, the image builder (BuildKit) |
| `gateway/src/proxy/` | agent ports, preview ports, WebSocket relay, header rules, connections, session cache |
| `gateway/src/service/` | service API and LLM API, the LLM proxy and queue under both, MCP server, URL policy, reader client |
| `gateway/src/updates/` | agent updater and versions, engine updater, registries, release cache |
| `gateway/src/monitor/` | live view, hostd client, host and LLM monitors, energy meter, prices, usage per user, session and API key |
| `gateway/src/lib/`, `gateway/test/` | HTTP helpers and `HttpError`, forwarding, logging; the harness, fakes and integration suites |
| `web/` | the web app (Next.js); installable through `app/manifest.ts`, without a service worker, since it does nothing offline |
| `harnesses/` | `@portal/harnesses`: the contract every agent's driver implements (`harness.ts`), the registry (`index.ts`), the admin's models (`models.ts`), what an agent is told (`instructions.ts`) |
| `harnesses/<name>/` | one agent, whole: `driver.ts` and `settings.ts` for the gateway, `harness.env` for the deploy scripts, `image/` with what its image installs (`install.sh`), checks (`check.sh`) and starts (`start.sh`) |
| `container/image/` | the one Dockerfile: the base every workspace has, with the toolchains, then the stage that installs one agent from its folder; the entry guard every start script sources |
| `container/security/` | `@portal/container`: the one security profile (`spec.ts`), the networks, the fence probe, the firewall (`firewall.sh`) |
| `reader/`, `searxng/` | the page reader (Python, Defuddle in Node); SearXNG with its `settings.yml` built in |
| `hostd/`, `models/` | portal-hostd; the model settings a fresh install starts with |
| `llm-server/` | the reference LLM server: engine service file, model download, load test, fan control for one board |
| `deploy/` | installer, isolation check, image update, model settings, HTTPS, uninstall; `lib.sh` is shared |

Imports go one way: `@portal/core`, then `harnesses`, then `container`, then the gateway. No file outside
`harnesses/<name>/` names that agent's files, port or package: the Dockerfile takes the agent as a build
argument, the deploy scripts source its `harness.env`, and `harnesses/index.test.ts` holds that file to the
driver. Adding an agent is a folder, an entry in the registry and a name appended to `AGENT_KINDS`.

The web app keeps sessions, renders the pages and calls the control API. Pages: `/login`, `/change-password`,
`/` (Home), `/workspace`, `/api-keys` (API: a page at `/api` would sit among the JSON routes), `/settings`, and
for the admin `/admin` (Usage), `/admin/energy`, `/admin/users` with `/new`, `/[id]` and `/[id]/workspace`,
`/admin/updates`, `/admin/audit`. JSON routes: `/api/health`, `/api/workspace/` `start`, `stop`, `status`,
`servers`, and `/api/admin/` `overview`, `agents`, `engine`, `energy`, `llm-sessions`, and the event stream
`live`. `/llm/api/*` is the [LLM API](#llm-api). Stable entry points: `web/lib/gateway.ts` (the only control
API client), `web/lib/config.ts` (the environment), `web/instrumentation.ts` (start-up: no start without the
control secret; creates the admin account when there is none) and `web/scripts/reset-admin-password.mjs`.

## Ports and addresses

| Listener | Address | Defined in |
|---|---|---|
| web app | `WEB_BIND:WEB_PORT` | `docker-compose.yml` |
| agent port of a workspace | `AGENT_BIND`, `AGENT_PORT_BASE` + the workspace's number | `agent-origin.ts` in core |
| preview port | agent port + `PREVIEW_PORT_OFFSET` (10000) | `wire/kinds.ts` in core |
| control API, LLM API | `127.0.0.1:CONTROL_PORT` | `gateway/src/main.ts` |
| service API | `WORKSPACE_GATEWAY_IP:SERVICE_PORT`, `ONLINE_GATEWAY_IP:SERVICE_PORT` | `gateway/src/main.ts` |
| agent in a container | Qwen Code 4170, DeepSeek Harness 3080, OpenCode 4096 | the drivers |
| SearXNG, page reader | `127.0.0.1:SEARXNG_PORT`, `127.0.0.1:READER_PORT`, container port 8080 | `docker-compose.yml` |

A workspace is one agent in one kind for one user, and has a number (`workspaceNumber` in `wire/kinds.ts`):
the user id × `WORKSPACE_BLOCK` (20), plus its place among the user's, agent by agent in the order of
`AGENT_KINDS`, each agent's Private before its Online. Its port is `AGENT_PORT_BASE` plus the number, its UID
`WORKSPACE_UID_BASE` plus the number. User 1 has 20 to 25: with the defaults, ports 12020 to 12025 and
previews 22020 to 22025. The rest of a block is for agents to come, and its ports stay closed. Neither a port
nor a UID moves when an agent is added or `AGENT_PORT_COUNT` changes, which is why `AGENT_KINDS` is
append-only. `deploy/lib.sh` counts the same way (`workspace_number`); `config.test.ts` compares the two.

A port is a browser origin. Each workspace has its own, so what one workspace's page keeps in the browser
(storage, a cache, a service worker, its token) is no other's, the same user's other agents and other kind
included. Web apps get the preview port for the same reason: an app's page is not the agent's origin. User
ids 1 to `AGENT_PORT_COUNT - 1` have ports; any other id gets 409 `no_workspace_port`. `deploy/lib.sh` holds
the offset too; `config.test.ts` compares them. Only the ports of the enabled agents listen (`workspacePorts`
in `config.ts`), and only those are mapped for HTTPS; an Online workspace's listen while `ONLINE_WORKSPACES` is
off too. A service listener waits up to 60 s for its bridge address; the gateway exits if it never appears.

Neither process speaks TLS. For HTTPS, `deploy/tailscale-https.sh` has Tailscale Serve end TLS on port 443 for
the web app and on each agent and preview port under its own number, and pass the bytes to 127.0.0.1, where it
binds them. `Host` and `Origin` arrive as the browser sent them and the URLs the web app builds take the page's
scheme, so the checks below hold unchanged. `PORTAL_HTTPS` tells the web app to mark its cookie `Secure` and
the gateway which origins to name: `https://host` for the portal instead of `http://host:WEB_PORT`.

## Data directory

```
PORTAL_DATA_DIR/                    root 0755
  db/portal.sqlite                  db/ is 10001's (the web app), 0700
  config/models/                    root 0700; settings.json, system-defaults.json, 0600
  config/instructions.md            optional, the admin's: what every agent is told beside its workspace's facts
  config/agent-versions.env         root 0600; the agent versions in use
  users/<id>/                       root 0711, as users/ itself
    <agent>/                        root 0711
      private/, online/             root 0711; one workspace each
        home/        -> /home/user  the workspace's UID, 0700
        workspace/   -> /workspace  the workspace's UID, 0700
        system/                     root 0755; rendered at every start, mounted read-only:
                                    settings/ (the agent's, and AGENTS.md), passwd, group
```

A workspace's UID and GID are `WORKSPACE_UID_BASE` plus its number, so no two workspaces share an owner, two
of one user included, and a workspace owns nothing outside its own `home/` and `workspace/`. The range, from
the base + 20 to the base + 20 × `AGENT_PORT_COUNT` - 1, must clear `/etc/subuid` and `/etc/subgid`: an
account with such a range could enter those UIDs through a user namespace. The base is for good, because the
files on disk belong to those UIDs. The installer creates the top level, `gateway/src/workspaces/paths.ts`
the rest. Database files the gateway creates as root go to the owner of `db/` (`packages/core/src/db.ts`):
the web app's account owns the database.

## Database

One SQLite file, opened by the web app and the gateway through `openDatabase` in `@portal/core` (WAL, foreign
keys on, a 5 s busy timeout). Times are integer milliseconds. `schema.ts` is the Drizzle view of it.

| Table | Holds | Written by |
|---|---|---|
| `users` | accounts: role (a unique index allows one admin), active, chosen agent, `online_allowed` | web app |
| `sessions` | id = SHA-256 of the cookie token, user, `acting_as_user_id`, expiry | web app |
| `login_attempts` | failed sign-ins per user name, for the lockout | web app |
| `portal_settings` | what the admin sets in the browser, one row per key | web app |
| `audit_log` | time, actor, action (`AuditAction` in `sessions.ts`), target, details | both |
| `workspaces` | the last known state of each user's container | gateway |
| `llm_usage` | requests and tokens per user and local day | gateway |
| `api_keys` | a user's keys for the LLM API: name, SHA-256 of the key, its last four characters, `revoked_at` | web app |
| `api_key_usage` | requests, tokens and energy per key and local day | gateway |
| `workspace_sessions` | one row per run of a workspace, with its LLM totals and energy | gateway |
| `host_daily` | each server's energy and network bytes per local day | gateway |
| `host_meter` | the last reading of each server's meter | gateway |
| `energy_prices` | published electricity prices per place and period | gateway |

Migrations (`packages/core/src/migrations.ts`) are append-only: a shipped one is never edited, a change is one
more entry, and `schema.ts` follows. `migrate` applies them by `PRAGMA user_version` in an immediate
transaction, so the two processes may open the database at the same moment.

## Sessions and browser authentication

The web app creates a session at sign-in: a random token in the cookie `portal_session` (HttpOnly,
SameSite=Lax, `Secure` with `PORTAL_HTTPS`), of which the database keeps only the hash. The gateway
reads sessions and never writes them. `loadSessionContext` returns the user and the *target*: whose workspace
the session uses, the user's own or, for an admin who opened one, `sessions.acting_as_user_id`.

Cookies ignore ports, so the browser sends the session cookie to every agent and preview port of the host.
That is how the gateway knows the session, and why rule 4 below exists. The gateway caches a session for 5 s;
the control API drops the entry on stop, release, delete and disconnect.

Each start generates the agent's credential (32 random bytes, `generateCredential`), which only the container
and the gateway hold. A driver declares one of two ways to let the browser's agent UI through (`browserAuth`):

- **token** (Qwen Code): the web app puts `agentBrowserToken(secret, session id, user id, workspace)`, an HMAC,
  in the iframe's URL fragment. The Web Shell presents it as a bearer token, or on a WebSocket as the
  subprotocol `qwen-bearer.<base64url>`. The gateway recomputes it and swaps it for the container's credential.
  The token is one session's for one workspace: useless without the session cookie, refused on every other
  workspace's port, the same user's included, and it ends with the session.
- **session** (DeepSeek Harness, OpenCode): the browser presents nothing more, and the gateway adds the
  credential to every request it forwards. For dsh it mints the cookie dsh expects, signed with the container's
  credential and valid for 10 minutes; for OpenCode the credential is the password of its HTTP sign-in.

## Workspace lifecycle

A user has a workspace for every agent and kind (`WORKSPACE_REFS` in `wire/kinds.ts`: six with three agents),
and one container at most: one of a user's workspaces runs at a time. `gateway/src/workspaces/manager.ts` keeps
one entry per user in memory, which names the workspace that runs or ran last (`agent` and `kind` in
`WorkspaceInfo`), and mirrors it to `workspaces`; `policy.ts` holds the decisions as pure functions.

| Status | Meaning |
|---|---|
| `stopped` | no container; when the container exited by itself, `lastError` says why |
| `starting` | the container is being created, or is up and its agent does not answer yet |
| `running` | the agent answered the driver's readiness probe; requests are forwarded |
| `stopping` | connections closed, `docker stop -t 10`, then removal |
| `error` | the start failed, or the container could not be stopped; `lastError` says which |

- **Start** happens only when the web app asks, or on "Try again" (below). No other request to a workspace
  port starts one, so an open tab's reconnect loop cannot wake a stopped workspace. A start names a workspace:
  without a kind Private, without an agent `users.agent` if enabled, else the first of `WORKSPACE_AGENTS`.
  While one of the user's workspaces is starting or running, a start of another is refused (409
  `another_running`), and what a start leaves out is the running one's, so it attaches. Online needs
  `ONLINE_WORKSPACES`, the fence and `users.online_allowed`.
- **Capacity**: at `MAX_RUNNING_WORKSPACES` a start evicts the ready workspace that has been idle longest, if
  idle for more than 5 minutes and not the requester's; otherwise 409 `capacity`.
- **Launch**: prepare the workspace's folders and settings, generate the credential, create the container (an
  earlier one of the user, whichever workspace's, goes first), then probe readiness for up to 90 s. A failed
  start leaves `error`, the container's last log lines in `lastError`, and no container.
- **Release** (a session ended) stops a workspace no session uses any more: at once, or when its work is done
  (`stopPending`). **Attach** (a session arrived) clears `stopPending` and starts nothing.
- **Reap**, every 60 s, in this order: an Online workspace that lost its permission stops, working or not; a
  working one stays; one no session uses stops (`logout`); one idle for `IDLE_TIMEOUT_MINUTES` stops (`idle`).
- **Working** means the agent reports a task, an LLM request is queued or in flight, or the container uses
  more than 0.15 cores. An agent that stops answering counts as working for 5 more minutes. A person acts by a
  navigation, a request the driver calls a user action, or a browser message on a socket; past
  `MAX_BUSY_HOURS` since the last such act, work stops counting, so a looping agent cannot hold a slot.
  A task is a turn, or a command a turn left running in the background. A turn that only waits for the person
  (an approval, a question) is a task for Qwen Code, which declines it after `IDLE_TIMEOUT_MINUTES`, and none for
  DeepSeek Harness and OpenCode, which leave it open for as long as nobody answers. OpenCode lists the sessions
  that run a turn on one route, for every project folder, and its background jobs on another; a subagent is a
  session of its own, which its approvals are asked in, and the session that started it does not run while it
  waits for it.
- **Reconcile**, at start and every 5 minutes: running containers of known users are adopted (agent, kind and
  version from their labels, the credential from their environment) and probed again; one that may not run is
  stopped instead: its agent is no longer enabled, or it is Online and that is refused. A container with unknown
  labels, or not named as its labels say
  (`wp-<agent>-<kind>-<user id>`), is nobody's and is removed, as is one of an unknown user or of a user id
  without a port: the gateway creates none like it, so nothing about it can be relied on. A container's exit is
  noticed within 15 s, or at once when a forwarded request fails.
- **Erase files** empties one workspace's `home/` and `workspace/`. It is refused while that workspace is
  starting, running or stopping, and touches no other: another of the user's may run meanwhile. **Delete data**
  waits for an erase under way, stops the workspace and removes `users/<id>/`, every workspace's files, and the
  row; if the stop fails nothing is deleted.

The gateway's shutdown leaves the containers running, which lets it restart without ending anyone's work. Stop
reasons in `workspaces.stop_reason` and the audit log: `admin`, `user`, `deactivated`, `deleted` (from the web
app), `logout`, `idle`, `capacity`, `online_disabled`, `online_not_allowed`, `agent_unavailable`, `error`.

## Agent ports, preview ports and the WebSocket relay

Every request to a workspace port passes `checkAgentAccess` (`gateway/src/proxy/agent-access.ts`) first:

1. The `Host` header parses (400 `bad_request`), and the local port names a workspace: a user, an agent and a
   kind (404 `not_found`).
2. An `Origin`, when sent, is exactly this host and port (403 `forbidden_origin`).
3. `Sec-Fetch-Site: cross-site` may only GET or HEAD, and no upgrade (403 `forbidden_cross_site`).
4. `Sec-Fetch-Site: same-site` may only navigate an iframe with GET or HEAD; on a preview port also a tab (403
   `forbidden_same_site`). SameSite=Lax does not hold between ports of one host, so this rule is what keeps
   the portal's page, or another workspace's, from acting with the user's cookie.
5. The session is live (401 `unauthenticated`) and its target is this port's user (403 `other_workspace`).

Then, on an agent port (`agent-proxy.ts`):

- An `Authorization` header must carry this session's browser token for this workspace, whatever the agent (401
  `invalid_token`).
- Only the port's own workspace is reached. Otherwise: 409 `another_running` while another of the user's
  workspaces is starting, running or stopping, else 503 `workspace_starting`, `workspace_error` or
  `workspace_stopped`. Navigations get a page; after a failure or at the cap it offers "Try again" (`POST
  /__portal/start`), which starts this port's workspace: its agent and its kind.
- A driver's blocked paths (pairing a phone, another browser or a remote machine; OAuth sign-ins) are refused in
  every spelling (403 `not_available`).
- Going in, the gateway removes hop-by-hop headers, `Host`, `Cookie`, `Origin`, `Authorization`, `Expect`,
  `Forwarded`, `X-Forwarded-*`, `X-Real-IP` and `Sec-Fetch-*`; the driver then sets `Host` and the credential,
  which a token agent gets only on requests that presented the browser token.
- Coming out, it removes `Set-Cookie`, `WWW-Authenticate` and `X-Frame-Options`, sets `frame-ancestors` to the
  portal's origin, and makes `Cache-Control` `private, no-store` unless the agent's forbids reuse or says
  `immutable`.
- Bodies above `UPLOAD_LIMIT_MB` end in 413 `payload_too_large`; an agent that does not answer, in 502
  `workspace_unreachable` and a check of the container.

WebSockets (`ws-relay.ts`) exist only on the driver's socket paths (OpenCode's is one per terminal,
`/api/experimental/persistent-pty/<id>/connect`); a target with a `#` is a 400. The gateway connects to the
workspace first and accepts the browser once the workspace has accepted, so a refusal comes back as a plain HTTP
status. It pings the browser every 20 s, drops it after two missed pongs, and pauses a sender while 4 MiB wait
for the other side. A session that ended, or moved to another workspace, has its connections closed with code
4001.

A preview port (`preview-proxy.ts`) passes the same five checks. `GET /__portal/port/<n>/<path>` stores n
(1024 to 65535, never the agent's port) in a cookie of that preview port and redirects to the path; later
requests, WebSockets included, go to `<container>:<n>`. The app sees a browser on its own machine (`Host`,
`Origin` and `Referer` say `localhost:<n>`) and none of the portal's cookies, and cannot set one. Its pages
may be framed by its workspace's agent port and the portal. A Private workspace's app also gets a
Content-Security-Policy that confines loads, connections and forms to the preview origin: code running in the
person's browser must not carry out data the workspace itself cannot send.

The portal finds the servers; nobody types an address. `GET /control/workspaces/:userId/servers` reads the
kernel's tables of the workspace that runs (`cat /proc/net/tcp /proc/net/tcp6` in the container, as its user)
and lists the listening ports from 1024 up, without the agent's own (`workspaces/servers.ts`; the text comes out
of a workspace, so only lines of the kernel's exact form count, and at most 32 servers). Each has `reachable`:
the gateway connects to the container's address, so a server must listen on every address or on that one. One
on localhost only is listed as not reachable, unless the kernel picked its port, which marks a helper's socket.
An answer is kept for 2 s, so many viewers cost one read. The web app's Preview button
(`web/components/workspace/preview-button.tsx`, in the portal's bar and the workspace's) asks every 5 s while a
workspace runs. It shows nothing without a server, opens the only server in a new tab, and lists several in a
dialog; a server that is not reachable is listed with how to fix it (`--host 0.0.0.0`). Every agent is told the
same rule (below), and none has a preview pane of its own: such a pane runs in the person's browser, where
`localhost` is their own computer.

## Service API

One listener per kind on that kind's bridge address (`gateway/src/service/service-api.ts`). The caller is the
workspace whose container has the source address, among the running containers of that kind; any other address
gets 403 `forbidden`. A workspace cannot forge the address: it has no capabilities, and its network carries no
traffic between containers. This API is all that a user's workspaces have in common, and what it remembers of
one, the URLs it was shown, is kept by the workspace's number: no other workspace may open a page on that
account, the same user's included. State is per listener: nothing carries between kinds.

| Route | Does |
|---|---|
| `POST /llm/v1/chat/completions`, `/completions`, `/embeddings` | forwarded to `LLM_UPSTREAM_URL/v1/...` |
| `GET /llm/v1/models`, `/llm/v1/models/<id>` | the same |
| `POST /mcp/search` | MCP over streamable HTTP, stateless: `web_search`, and `read_page` when a reader is set |

- Nothing else under `/llm/v1/` is forwarded: the gateway adds the real key, so on a hosted provider any other
  endpoint (files, batches, fine-tuning) would be every workspace's to use.
- **Queue** (`llm-queue.ts`): generation requests take a slot, at most `LLM_MAX_CONCURRENCY` in all and
  `LLM_MAX_CONCURRENCY_PER_USER` each, first come first served; a user at the limit does not hold up the users
  behind. An engine update pauses the queue, and requests wait instead of failing.
- **Usage**: token counts are read from a copy of the answer as it streams (`monitor/usage.ts`) into
  `llm_usage` and the workspace's session row: the answer's `usage`, or for a stream that was not asked for
  one what the engine's closing `timings` say. Prompts and answers are not stored.
- **`web_search`** asks SearXNG, and once more the `SEARCH_FALLBACK_ENGINES` by name when fewer than
  `SEARCH_FALLBACK_BELOW` results came back. **`read_page`** asks the reader for a page and hands the model
  `READER_PAGE_CHARS` at a time. Both are limited per user and cached for some minutes.
- **Exa first** (`exa-search.ts`, `EXA_SEARCH=on`): one tool call to Exa's hosted MCP server, which takes it
  without a handshake, an account or a key, at a limit Exa does not publish. Exa is asked what its tool can
  answer as asked: the first page, with no time range and no language. SearXNG answers the rest, and every
  search for ten minutes (or the time Exa names) after Exa refused, failed or sent an answer the gateway does not
  read. The results come back in SearXNG's form, so the model's tool is the same. It is a setting because each
  query Exa gets leaves the server for a company.
- **URL policy** (`url-policy.ts`, `READER_URL_POLICY=shown`): `read_page` opens a URL the workspace was shown
  (a search result, a page it read, its conversation except the assistant's own messages) or one on a trusted
  host (`READER_TRUSTED_HOSTS`, else `DEFAULT_TRUSTED_HOSTS` in `config.ts`). The reason: a page can tell the
  agent to fetch a URL that carries data out in its query, and a URL the model composed is not a shown one. A
  URL admitted only for its host may redirect only to trusted hosts.
- **The reader** (`reader/reader.py`) connects only to public IPv4 addresses on ports 80 and 443, to the very
  address it checked, redirects included. Each request is its own process, limited in time, bytes and memory.

## LLM API

`/llm/api/<path>` is the LLM server's `<path>` for software outside the portal (an editor, a script), opened by
a key its user made on the API page. `https://<portal>/llm/api/v1` is an OpenAI base URL.

```
client --(key)--> web app  app/llm/api/[[...path]]/route.ts
                     |  the same request, unread
                     v
                  gateway  127.0.0.1:CONTROL_PORT/llm/api/<path>  (service/llm-api.ts)
                     |  the key checked and taken off, LLM_API_KEY put on
                     v
                  LLM_UPSTREAM_URL/<path>
```

- **The web app is a pipe.** Method, path, query, headers (but `cookie`) and body go on as they came, and the
  answer comes back as it streams. It uses `node:http`: `fetch` gives up after 300 s without response headers,
  and a long prompt is read for longer than that. Next.js cuts a request body off at 10 MB unless
  `proxyClientMaxBodySize` says otherwise; `LLM_API_BODY_BYTES` in `web/lib/limits.ts` (64 MiB, the reference
  engine's own limit) sets it, and the route answers a longer body with 413.
- **The gateway checks the key.** On the control listener `/llm/api` is opened by an API key and every other
  path by the control secret. A key is `sk-` and 48 hex digits, given as `Authorization: Bearer` or as
  `x-api-key` (Anthropic's clients). It holds while it is not revoked and its user is active without a temporary
  password; anything else gets 401 `invalid_api_key` in OpenAI's error shape. `OPTIONS` passes without a key,
  because a browser's preflight carries none.
- **Every path is passed on**, where a workspace gets five: the API stands in for the LLM server's own, and its
  caller is a user, not an agent that a web page can talk into things. With a hosted provider behind
  `LLM_UPSTREAM_URL`, a key so opens all of that provider's API on the portal's account. WebSocket upgrades
  are not passed.
- **Queue and counting** are the workspaces' (`service/llm-proxy.ts`). A `POST` is a generation unless its path
  only counts or formats a prompt (`NOT_A_GENERATION`): it waits for a slot within the same limit per user,
  counts in `llm_usage`, and counts per key and day in `api_key_usage` (`monitor/key-usage.ts`) where a
  workspace's counts in its session. A waiting request's body stays unread, for longer than the 5 minutes Node
  allows a request by default, so the control listener sets no such limit.

## Gateway control API

`127.0.0.1:CONTROL_PORT`, `Authorization: Bearer GATEWAY_CONTROL_SECRET`, JSON in and out, errors
`{ error, message }`. Any route: 401 `unauthorized`, 404 `not_found`, 405 `method_not_allowed`, 413
`payload_too_large` (bodies above 16 KiB), 400 `invalid_json`, `bad_request`, `invalid_user_id`,
`invalid_actor` (an `actorUserId` that is no user), 500 `internal`. The types are in `@portal/core/wire`.

| Method | Path | Body, answer | Notable errors |
|---|---|---|---|
| GET | `/control/health` | `{ ok: true }` | |
| GET | `/control/stats` | `HostStats` | |
| GET | `/control/live` | an event stream, see [Live view](#live-view) | 429 `too_many_viewers` |
| GET | `/control/agents` | `{ agents: AgentInfo[] }`: the enabled agents | |
| GET | `/control/models` | `{ models }`: the ids in the admin's model settings, the default first | |
| GET | `/control/energy-prices` | `EnergyPriceStatus` | |
| POST | `/control/energy-prices/refresh` | the same, once both sources are done | |
| GET | `/control/updates/running` | `{ running, agent, engine }`, for the deploy scripts | |
| GET | `/control/agents/versions[?refresh=1]` | `AgentVersionsOverview` | |
| POST | `/control/agents/update/cancel` | `{ cancelled }` | |
| POST | `/control/agents/:agent/update` | `{ version, rebuild?, actorUserId? }`, `AgentUpdateJob` | 400 `unknown_agent`, `invalid_version`, `agent_unavailable`; 404 `version_not_found`; 409 `update_running`; 502 `registry_unreachable` |
| DELETE | `/control/agents/:agent/images/:version` | `{ ok: true }` | 400 `unknown_agent`, `invalid_version`; 404 `not_found`; 409 `image_current`, `image_in_use`, `update_running` |
| GET | `/control/engine[?refresh=1]` | `EngineOverview` | |
| POST | `/control/engine/update` | `{ version, actorUserId? }`, `EngineUpdateJob` | 400 `invalid_version`; 404 `version_not_found`; 409 `already_current`, `engine_job_running`; 503 `engine_unavailable` |
| POST | `/control/engine/cancel` | `{ cancelled }`: while pulling or draining | |
| POST | `/control/engine/restart-now` | `{ ok }`: ends the drain | |
| DELETE | `/control/engine/images/:digest` | `{ ok: true }` | 400 `invalid_digest`; 409 `engine_job_running`; hostd's own 404 and 409 codes; 502 `hostd_failed`; 503 `engine_unavailable` |
| GET | `/control/workspaces` | `{ workspaces: WorkspaceInfo[] }` | |
| GET | `/control/workspaces/:userId` | `WorkspaceInfo`; `stopped` for a user without a row | |
| GET | `/control/workspaces/:userId/servers` | `WorkspaceServers`: the web servers of the workspace that runs; counts as no activity | |
| POST | `/control/workspaces/:userId/start` | `{ agent?, kind? }`, `WorkspaceInfo` once the container exists | 400 `unknown_agent`, `unknown_kind`, `agent_unavailable`; 403 `online_not_allowed`; 404 `user_not_found`; 409 `no_workspace_port`, `deleting`, `another_running`, `online_disabled`, `capacity`; 500 `start_failed` |
| POST | `/control/workspaces/:userId/stop` | `{ reason?, actorUserId? }`, `WorkspaceInfo`; reason defaults to `admin` | 400 `invalid_reason` |
| POST | `/control/workspaces/:userId/attach` | `WorkspaceInfo` | |
| POST | `/control/workspaces/:userId/release` | `WorkspaceInfo` | |
| DELETE | `/control/workspaces/:userId/files?kind=&agent=` | `{ actorUserId? }`, `{ ok: true }`: one workspace's files erased | 400 `unknown_kind`, `unknown_agent`; 404 `user_not_found`; 409 `workspace_running`, `deleting` |
| DELETE | `/control/workspaces/:userId/data` | `{ ok: true }` | 500 `stop_failed` |
| POST | `/control/sessions/:sessionId/disconnect` | `{ closed }`: connections closed | |

`reason` is one of `STOP_REASONS` in `wire/kinds.ts`. In a start's body a `null` `agent` or `kind` counts as
absent; `files` needs both. A `WorkspaceInfo` is a user's: its `agent` and `kind` name the workspace that runs,
or ran last.

## Wire contract

`packages/core/src/wire/` holds what the gateway sends and the browser may read: the control API's types
(`types.ts`), the shared names and limits (`kinds.ts`), the version syntax (`versions.ts`) and the energy
price places (`energy-locations.ts`). Nothing in the folder imports from outside it, so client components can
import values from `@portal/core/wire`; the package's main entry brings SQLite along and is for server code.
`web/lib/client-imports.test.ts` checks both halves of that rule. A change to a control API answer is a change
to `types.ts` first: the gateway and the web app compile against it.

## Agent settings rendering

The admin writes the models as Qwen Code settings (`config/models/`, JSON with comments); each agent's driver
(`harnesses/<name>/driver.ts`, `settings.ts`) renders a workspace's own settings at every start into its
`system/settings/`, mounted read-only. What the renderers guarantee:

- **Instructions** (`harnesses/instructions.ts`): every workspace gets an `AGENTS.md` beside its settings. It
  states what an agent cannot find out by looking: which folders are kept, that `/tmp` runs no program, what
  the network of its kind reaches, the tools installed, and that a web server must listen on `0.0.0.0` and is
  opened with the Preview button, never by a localhost link. The admin's `config/instructions.md` follows when
  there is one (at most 32 KiB, since every request carries it; a longer or unreadable file fails the start
  with `AgentConfigError`). It applies to every user's agents. OpenCode reads the file through its managed
  `instructions` setting. Qwen Code reads it as the context file of an included folder
  (`context.includeDirectories` with `loadFromIncludeDirectories`), which also lists that folder among the
  agent's working directories. DeepSeek Harness reads the `AGENTS.md` of its shared agents folder
  (`DSH_AGENTS_HOME`), which its start script puts together in `/tmp` from this file and the person's own
  `~/.agents/skills`; a person's own instructions for dsh go in `~/.dsh/AGENTS.md`. Only OpenCode's image build
  proves that the text reaches the model; for the other two the build checks that the agent still has the
  setting it is given.

- **Models** are the `modelProviders.openai` entries: `system-defaults.json` must hold at least one with an
  `id`, and a list in `settings.json` replaces it. Every entry gets the service API's `/llm/v1` as `baseUrl`
  and the placeholder key's name as `envKey`; any `apiKey` in it and every other provider are removed. Without
  a model that agent's workspaces do not start (`AgentConfigError`); the gateway stays up.
- **Forced in `settings.json`**, over whatever the admin wrote: no auto-update, no telemetry or usage
  statistics, no model catalog refresh, OpenAI-compatible auth, `web_fetch` denied, the built-in web search
  removed, and the MCP server `search` (plus `browser` with `WORKSPACE_BROWSER`).
- **DeepSeek Harness** gets the same models as a patch file written as JSON, which is valid YAML: dsh
  evaluates YAML tags, and JSON has none, so no string of the admin's can become one. Models whose context
  window leaves dsh too little room are left out (`fitDshModels` in `harnesses/dsh/settings.ts`). Otherwise dsh
  runs as it ships: a static lockdown patch in the image turns off only the DeepSeek sign-in and API, the built-in
  web tools and opening folders in desktop apps, turns on agent teamwork for new sessions, and names
  `~/Documents` as dsh's Documents folder. The image build fails when a row of it does not apply (one marked
  optional may be missing: agent teamwork, which dsh 0.2.2-rc.1 does not have), or when a setting a row gives is
  not one its plugin declares, with a value it takes, because dsh would ignore it without a word
  (`check-lockdown-config.mjs`). `DSH_PERMISSION_MODE` in the image starts new sessions with Full access, and
  `default-profile.mjs` switches Auto review on once in each person's profile.
- **dsh's dark theme** (`harnesses/dsh/image/portal-theme.mjs`): a stylesheet in its frontend's `index.html` sets
  its dark surface tokens (page, sidebar, panels, message box, code blocks) to the Web Shell's blacks, which
  `web/app/theme.css` copies, and its boot background follows; its light theme and what sits on the surfaces stay
  dsh's own. When the theme no longer defines a token the sheet sets, the build fails.
- **OpenCode** (OpenCode 2, the npm package `@opencode/cli`) gets the same models as `opencode.json` in
  `/etc/opencode`, its directory for managed settings. What the file names wins over a person's and a project's
  own settings, under the older names OpenCode still reads too; what it leaves out stays theirs, a permission
  rule for another tool included. It names the portal's provider and, by policy, no other (OpenCode otherwise
  offers hosted models of its own; a session that names one fails), no update and no session sharing, its
  `webfetch` and `websearch` tools off, the `fetch` of its `execute` tool with them, the MCP server `search`
  (plus `browser` with `WORKSPACE_BROWSER`), whose tools the model calls by name, and its
  [toolset](#opencodes-toolset). The image adds
  `OPENCODE_DISABLE_MODELS_FETCH`: its list of the world's models stays the one it ships with. A model's efforts
  are its variants in OpenCode's picker, and its default effort goes with every request for which no variant
  was picked. A start is refused (`AgentConfigError`) when a model's id or name contains `{env:` or `{file:`,
  which OpenCode would replace, or its id a `#`, which OpenCode reads as the start of a variant's name. No file
  of OpenCode is edited in the image; the build only removes the builds this CPU does not run. OpenCode loads
  its native libraries from its temporary folder, and `/tmp` forbids execution, so the start script points
  `BUN_TMPDIR` at a folder in the home; without the libraries OpenCode watches no folder for changes. Sessions
  are OpenCode's own and show in any browser; the projects in its sidebar and its open tabs are kept in the
  browser, per workspace port. OpenCode 1 is another package (`opencode-ai`) with other settings and another
  API; this driver is not for it.
- **OpenCode's build check** (`harnesses/opencode/image/check-serve.mjs`) starts OpenCode once, without a
  network, against a stand-in for the service API, with settings a test keeps as the renderer writes them. The
  build fails when OpenCode does not serve its page, or serves its API to anyone without its password; when a
  person's or a project's settings undo the managed ones or move its server; when a plugin of the settings does
  not run or a skill is not listed; when a turn asks the model with another key, output limit, effort or set of
  tools, or without the instructions and Superpowers' introduction; when Safety Net lets `git reset --hard`
  through or a Go file the model writes stays unformatted; when the routes of the status check (a running turn,
  a pending approval, a background job) or a terminal's ticket and socket answer differently; or when its
  native libraries are not unpacked into `BUN_TMPDIR`.
- **The Web Shell trim** (`harnesses/qwen/image/trim-web-shell.mjs`) removes what the portal does not offer,
  the Web preview pane included, sizes the dropped-file dialog to its buttons and keeps a turn's
  answer on screen when replies to background tasks follow it. Its uploads take the gateway's `UPLOAD_LIMIT_MB`
  and go to disk as they arrive; as shipped, the daemon holds each one in memory, up to 50 MiB. All or nothing:
  when a change does not fit, the trim names it and the build fails.

### OpenCode's toolset

What an OpenCode workspace starts with, beside OpenCode's own tools. `harnesses/opencode/image/install.sh`
downloads the plugins and skills into the image, each at one version and refused when its SHA-256 differs, and
the managed settings load them from there (`plugins`, `skills`), so a Private workspace has them without a
download. A person adds their own in `~/.config/opencode` or a project's `.opencode/`.

| Kind | What | For |
|---|---|---|
| Plugin | [Superpowers](https://github.com/obra/superpowers) 7.0.2 | 15 skills for working in steps (brainstorm, plan, test first, debug by cause, review), and a note in every session that says to use them |
| Plugin | [Safety Net](https://github.com/kenryu42/claude-code-safety-net) 2.8.3 | refuses commands that destroy work (`git reset --hard`, `rm -rf` of a home or repository, an install script piped from the internet) and reads of keys and credentials |
| Skill | `frontend-design` ([anthropics/skills](https://github.com/anthropics/skills)) | UI that does not look like a template |
| Skill | `react-best-practices` ([vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)) | React and Next.js performance rules |
| Skill | `shadcn` ([shadcn-ui/ui](https://github.com/shadcn-ui/ui)) | shadcn/ui components; its CLI needs an Online workspace |
| Skill | `research` ([mattpocock/skills](https://github.com/mattpocock/skills)) | research against primary sources, written up with citations; it uses the portal's search and page reader |
| Skill | `competitive-programming` (the portal's own, `image/skills/`) | contest problems in C++: flags, sanitizers, a stress test against a brute force |
| MCP | `search` (the gateway), `browser` (Playwright MCP, headless Chromium) | web search and page reading; looking at the app the agent built |
| MCP | `context7`, `grep` (Online only) | a library's current documentation ([Context7](https://context7.com)); code search over public GitHub repositories ([grep.app](https://grep.app)). Public services without an account: what the agent asks them leaves the portal |
| Setting | `formatter` | a file is formatted after an edit: gofmt, rustfmt, ruff and shfmt from the image; prettier or biome when the project has them |

Left out, and why:

| What | Why |
|---|---|
| A plugin for creating, renaming and deleting folders in OpenCode's web page | none exists that is widely used; the agent and the terminal do it |
| oh-my-opencode | it left OpenCode for a harness of its own |
| oh-my-opencode-slim | it divides work among several models; the portal serves one |
| Dynamic Context Pruning | it rewrites earlier messages, which makes the model server read the whole conversation again |
| opencode-mem | it downloads an embedding model |
| opencode-pty | OpenCode 2 runs background commands itself |
| Plugins for OpenCode 1 | OpenCode 2 has another plugin API |
| `web-design-guidelines`, `webapp-testing` skills | the first fetches its rules from the internet at every use; the second needs Playwright for Python |
| Serena, chrome-devtools-mcp | they overlap with OpenCode's own code search and with the `browser` server |
| Language servers | OpenCode 2 runs none |

## Workspace image

`container/image/Dockerfile` builds one image per agent and version: a base stage, the same for every agent,
then a stage that takes `HARNESS` and `HARNESS_VERSION` and runs that agent's `install.sh`, its `check.sh`
without a network, and installs its `start.sh` as the entrypoint. Every start script sources the entry guard
(`entry.sh`), which refuses root, sets the agent's environment (its `env.sh`), finds the container's address
and gives Go a folder it can run programs from (`GOTMPDIR`), because `/tmp` is `noexec`.

The base holds what a Private workspace could not download (`toolchains.sh`): Go, Rust (compiler, cargo,
rustfmt, clippy; no rustup), uv, ruff, PowerShell, shellcheck and shfmt, each its maker's release at one
version, refused when its SHA-256 differs (amd64 and arm64); `build-essential` and `gdb` from Debian; pnpm and
Playwright MCP from npm. `check-toolchains.sh` runs in the build without a network and fails it unless C, C++
(with the sanitizers), Go, Rust, Python, Bash, PowerShell and Node each build and run a program.
`fetch.sh` is the download helper both the base and an agent's `install.sh` use. Raising a version means its
new SHA-256 values too.

## Agent versions and updates

The version the next workspaces start with is per agent: `config/agent-versions.env` if it names one, else the
`.env` default. The image is `workspace-portal/workspace:<agent>-<version>`. Running workspaces keep theirs.

One update job runs at a time, for all agents (`gateway/src/updates/agent-updater.ts`). Its record is
`AgentUpdateJob` in the wire types: versions, phase, step, the log's tail, error. Phases: `building`,
`verifying`, then `succeeded`, `failed` or `cancelled`.

1. The version is exact. An image on the server is reused unless `rebuild`; any other must be on npm.
2. The build goes to a staging tag (`workspace-build:`), never to the tag workspaces start from.
3. Verifying asks the agent's CLI for its version in a container without network or privileges: it must match.
4. Promotion tags the image, saves the version and audits `agent_updated`; from there it is not cancellable. A
   failure or a cancel discards the staging image, audits `agent_update_failed` and leaves the version.

A version the portal's changes or checks don't fit fails at step 2: the Web Shell trim, dsh's preset, theme,
profile and lockdown checks, and OpenCode's `check-serve.mjs` fail the build. A failed build's
error is the failed step's last ten output lines, then the engine's message, so it says what did not fit.

A gateway that stops mid-job records it as failed; at its next start `sweep` removes staging tags and check
containers before the control API listens. `deploy/update-image.sh` does the same build from the shell, writes
the same file, and refuses while `/control/updates/running` reports a job.

## LLM engine updates

`gateway/src/updates/engine-updater.ts` drives portal-hostd on the LLM server, which owns the engine's
container; the steps hostd runs are in [hostd/README.md](../hostd/README.md). Phases: `pulling`, `draining`,
`restarting`, then `succeeded`, `failed` or `cancelled`.

- The version is a stable `X.Y.Z` tag of the quadlet's repository; the gateway resolves its digest in the
  registry and hostd pulls by digest while the engine keeps serving. An image already there skips the pull.
- Draining pauses the LLM queue and waits until no request is in flight, `ENGINE_DRAIN_MINUTES` have passed,
  or the admin chooses "Restart now". Waiting requests are held, not failed. Until then a cancel works.
- Restarting is hostd's `apply`. If it fails hostd puts the previous image back and the job ends `failed`,
  its error ending with the engine's own last log lines (an option the new version refuses, say);
  `rolledBack` says whether the previous engine serves again. The queue resumes in every case. A gateway that
  stops mid-job records it as failed, with a note to check the engine's version: hostd carries on.

## Live view

`GET /control/live` (`monitor/live.ts`) is a server-sent event stream for Admin > Usage: `init` once, then a
`frame` every 500 ms with both servers' readings, the LLM sessions and the queue. At most 8 viewers; a slow
one skips frames. What feeds it (hostd's streams, the engine's `/slots`) runs only while someone watches.
These parts of `gateway/src/monitor/` run all the time:

- **Energy meter**: every 30 s it reads each hostd's running totals and books the increase to the local day in
  `host_daily`. `host_meter` keeps the last reading, so a gateway restart counts only what came after it. A
  day is the server's local day (`TZ`), the same in the web app and the gateway (`usage-day.ts`).
- **LLM energy**: while requests run, the LLM server's meter is read every 2 s and each stretch is shared
  among the running requests by time, into the `workspace_sessions` row of a workspace's request and the
  `api_key_usage` row of an API key's. Idle draw belongs to no one. Admin > Energy adds both up per user and
  day, a session on the day it started.
- **Electricity prices**: EIA (US states) and Eurostat (European households) into `energy_prices` at start,
  daily and on refresh. A page that does not parse is an error, never a wrong price.

## Isolation and firewall

| Guarantee | Enforced by |
|---|---|
| A workspace has no privilege | `container/security/spec.ts`: own UID, read-only root, all capabilities dropped, `no-new-privileges`, limits; images without setuid programs |
| It sees only its own files | binds of its own `home/`, `workspace/` and `system/` files alone; folders 0700, each workspace's under its own UID |
| A user's agents and kinds have nothing in common but the service API | per workspace: folders, UID, container, browser origin (its two ports) and browser token; the service API keeps what a workspace was shown by its number |
| It talks to no other container | Docker networks with inter-container traffic off; the firewall's `never` set |
| Private reaches only the service port | an `internal` Docker network; nftables drops everything else from its bridge |
| Online reaches that, DNS on two resolvers and public IPv4 over TCP | nftables `online_to_host`, `online_out`, `online_in` |
| No internet names resolve on the internal network | Docker 25.0.5 or newer, checked by installer and gateway |
| The rules are there whenever a container runs, and nothing reopens a drop | a systemd unit Docker requires, ordered before it; base chains at priority `filter - 10`, where a drop is final |
| Online never runs without the rules | the fence probe, below |
| SearXNG and the reader reach the public web only | their own bridges and chains: DNS, TCP 80 and 443 |

The origin belongs in that row because a browser gives storage, caches and service workers to an origin, not to
a page: an agent's page that registers a service worker, as OpenCode's does, would otherwise answer for every
agent served on its port.

`container/security/firewall.sh` builds the table `inet workspace_portal` and loads it in one transaction. It
matches each bridge by name and by subnet. Its `not_public` set must equal `NOT_PUBLIC` in `gateway/src/config.ts`;
`config.test.ts` compares them. The `never` set holds the container subnets and what the installer resolved:
this host's networks, its routers, the servers the `*_URL` settings name and `FIREWALL_NEVER_REACH`.

The gateway has no `CAP_NET_ADMIN` and cannot list rules, so the table carries a marker: its first rule
rejects TCP to `127.0.0.1:SERVICE_PORT`, where nothing listens. Unless `ONLINE_WORKSPACES` is off, `fence.ts`
(`container/security/`)
connects there every 5 s (not while the check before still runs), and `EHOSTUNREACH` means loaded. On any
other answer the gateway stops every Online workspace (`online_disabled`) and refuses Online starts; it asks
once more right before an Online container starts.

Docker's networks are checked attribute by attribute at start (`ensureNetwork`): a differing network is
replaced when unused, otherwise the gateway refuses to start. `deploy/verify-isolation.sh` asserts these
guarantees on the running host, with probes from throwaway containers.

## Configuration

[`.env.example`](../.env.example) is the one place for a setting's name, default and meaning. The installer
copies every setting `.env` lacks from it, the deploy scripts fall back to it (`env_get` in `deploy/lib.sh`),
and `config.test.ts` holds the defaults built into `gateway/src/config.ts` to it. Readers: the gateway
(`config.ts`), the web app (`web/lib/config.ts`: the data directory, ports, the secret, `SESSION_*`,
`IDLE_TIMEOUT_MINUTES`, `ADMIN_*`), the reader (the limits `.env.example` calls its own), SearXNG
(`SEARXNG_SECRET`) and the deploy scripts. `loadConfig` checks relations as well as values: the workspaces'
ports and UIDs (`numberingProblems`: ranges that do not fit, that hold `WEB_PORT`, `CONTROL_PORT` or
`SERVICE_PORT`, or that would serve a workspace on a port browsers refuse to open), subnets and resolvers
(`networkProblems`). The installer checks the stack's ports against the ranges first, before it builds.

## Testing

`npm test` runs Node's test runner on the TypeScript sources of the five workspaces.

| Suite | Covers |
|---|---|
| `packages/core/src/**/*.test.ts` | opening and migrating the database, the version syntax, a workspace's number, port and token |
| `harnesses/**/*.test.ts` | each driver and its settings, the models, the instructions; every `harness.env` against its driver |
| `container/security/*.test.ts` | the security profile and its bash twin (`sandbox.sh`), the networks, the fence probe |
| `gateway/src/**/*.test.ts` | each module beside its source: policy, headers, URL policy, servers, updaters |
| `gateway/test/*.test.ts` | the whole gateway through its real listeners |
| `web/lib/**/*.test.ts` | the web app's pure logic, the wire contract's import rule, its fallbacks against `.env.example` |
| the workspace image build | without a network: the toolchains build and run a program each; the agent's own `check.sh` (see [Agent settings rendering](#agent-settings-rendering)) |
| `reader/test_*.py` | address checks, conversion, PDFs; run in the image build, which fails with them |
| `hostd/test_hostd.py` | portal-hostd against a fake `/proc` and `/sys`: `python3 -m unittest hostd/test_hostd.py` |
| `llm-server/fans/test_fans.py` | the fan curve and its loop against fake sensors, run the same way |
| `deploy/verify-isolation.sh` | the installed system: the only check of real Docker and nftables |

`gateway/test/harness.ts` builds the gateway with the production `compose()` over a real SQLite file and puts
fakes where the outside world is, most of them through `Seams`: a Docker runtime whose containers are
in-process agent servers, an image builder, the registries, an engine host, an LLM server, a search backend
and a clock. So a test runs production's wiring, and a dependency on the outside world is a seam in
`compose.ts`.

## Conventions

- **Errors** are `HttpError(status, code, message)`, thrown where the fault is found and turned into
  `{ error, message }` by the server. The code is the contract; the message is for people.
- **Comments** state constraints and reasons, never what the code does.
- **One implementation per concern.** Where a second copy is unavoidable (bash cannot import TypeScript), a
  comment names its twin and, where possible, a test compares them.
