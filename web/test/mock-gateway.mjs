// Test double for the gateway, for local end-to-end runs of the web app. NOT used in production.
// Implements the control API (docs/ARCHITECTURE.md) with in-memory workspace state, plus a tiny
// workspace port per user and kind (Private: AGENT_PORT_BASE + id, Online: ONLINE_AGENT_PORT_BASE + id) that resolves
// the portal_session cookie like the real proxy, refuses sessions using another workspace, and shows whose workspace
// it is, its kind and which agent runs there (the other kind running, or none: the gateway's themed pages; nothing
// starts from a port). Like the real gateway, start answers at once with "starting", and the workspace turns
// "running" and ready startMs later. A workspace runs one agent and one kind at a time. A start without `{kind}`
// attaches to a workspace that is starting or running, else starts Private; naming the other kind while one runs is
// 409 kind_mismatch; Online while the global switch is off is 409 online_disabled, for a user whose
// users.online_allowed is 0 403 online_not_allowed. A start without `{agent}` (what the portal sends) launches the
// user's harness (users.agent, chosen in Settings) if enabled, else the first enabled agent; a start naming another
// agent while one runs is refused (409 agent_mismatch). POST /control/workspaces/:id/attach only calls off a pending
// stop, as on the gateway. DELETE /control/workspaces/:id/files?kind= erases one kind's files (409 workspace_running
// while that kind is starting, running or stopping) and audits workspace_files_erased {kind} as the gateway does.
//
//   PORTAL_DATA_DIR=... GATEWAY_CONTROL_SECRET=... CONTROL_PORT=4002 AGENT_PORT_BASE=3100 AGENT_PORT_COUNT=20 \
//   MOCK_AGENTS=qwen,dsh node test/mock-gateway.mjs
//
// ONLINE_AGENT_PORT_BASE defaults to AGENT_PORT_BASE + AGENT_PORT_COUNT (as for the web app and the gateway), and
// ONLINE_WORKSPACES=on|off (default on) is the global Online switch.
// MOCK_AGENTS (default "qwen,dsh") lists the enabled agents in display order, like the gateway's WORKSPACE_AGENTS.
//
// Agent versions (docs/ARCHITECTURE.md, "Agent versions and updates"), with an in-memory npm registry (publish
// times, dist-tags, GitHub release notes) and image store: GET /control/agents/versions[?refresh=1] lists each
// agent's releases as the gateway picks them (the 5 newest stable ones, the current one, those with an image), POST
// /control/agents/:agent/update with an exact version (one whose image is on the server, the current one included,
// skips the registry and the build unless from scratch: it logs that it uses that image and only the version check
// runs; any other is a simulated build, steps and log lines over MOCK_BUILD_MS, default 20 s, then the version
// check; then the version is current), POST /control/agents/update/cancel, DELETE
// /control/agents/:agent/images/:version. The same refusals and error codes as the gateway, which writes the
// agent_updated / agent_update_failed audit entries as the gateway does. It starts with Qwen Code 0.27.0 (latest is
// 0.27.4; 0.27.2 has breaking changes; 0.26.0 is on the server too, without release notes) and DeepSeek Harness
// 0.2.2-rc.1 (latest, every release a prerelease; 0.2.1-rc.5 is on the server too). Workspaces report the version
// they started with.
//
// Test hooks (no auth): POST /__mock/workspaces/:id/stop?reason=idle,
// POST /__mock/workspaces/:id/connections?admin=N&owner=N, POST /__mock/workspaces/:id/busy?on=1|0,
// POST /__mock/workspaces/:id/error?message=… (a start that failed),
// POST /__mock/workspaces/:id/kind?kind=online (the kind a stopped workspace ran last, for screenshots),
// POST /__mock/config?maxRunning=N&startMs=N&stopMs=N&buildMs=N&agents=qwen,dsh&online=on|off (off stops the running
// Online workspaces, stopReason "online_disabled", as a gateway started with the switch off), GET /__mock/log (paths
// in `log`, and `calls` with method, path and JSON body). A user's own Online permission is users.online_allowed in
// the DB (the admin's switch).
// Agent versions: POST /__mock/agents/reset (the starting versions and images, no job),
// POST /__mock/agents/fail-next?message=… (the next job's build fails at its last step; without a message, as a
// DeepSeek Harness lockdown that doesn't fit), POST /__mock/agents/drop-image?agent=dsh&version=0.2.2-rc.1 (an image
// gone from Docker, e.g. the current one), POST /__mock/registry?down=1|0&known=0 (the npm registry unreachable;
// known=0: it never answered, so the releases' dates, notes and latest are unknown).
// The live view (GET /control/live) and LLM engine updates (/control/engine...) are simulated in mock-live.mjs, with
// its hooks POST /__mock/live?... and POST /__mock/engine?... (see there).
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { createMockLive } from "./mock-live.mjs";

const env = process.env;
const controlPort = Number(env.CONTROL_PORT || 4002);
const agentPortBase = Number(env.AGENT_PORT_BASE || 3100);
const agentPortCount = Number(env.AGENT_PORT_COUNT || 20);
const onlineAgentPortBase = Number(env.ONLINE_AGENT_PORT_BASE || agentPortBase + agentPortCount);
const secret = env.GATEWAY_CONTROL_SECRET || "";

/** The two workspaces every user has (@portal/db WORKSPACE_KINDS), with their display names. */
const KIND_NAMES = { private: "Private", online: "Online" };
const isWorkspaceKind = (value) => typeof value === "string" && Object.hasOwn(KIND_NAMES, value);

/** Every agent kind the gateway knows (GET /control/agents lists the enabled ones, with their current version). */
const AGENTS = {
  qwen: {
    id: "qwen",
    name: "Qwen Code",
    description: "Qwen Code's Web Shell: chat, files, terminal and a headless browser.",
    defaultVersion: "0.27.0",
    packageName: "@qwen-code/qwen-code",
    cli: "qwen",
  },
  dsh: {
    id: "dsh",
    name: "DeepSeek Harness",
    description: "DeepSeek Harness (dsh): chat, files, terminal and a headless browser.",
    defaultVersion: "0.2.2-rc.1",
    packageName: "@deepseek-ai/dsh",
    cli: "dsh",
  },
};
const isAgentKind = (value) => typeof value === "string" && Object.hasOwn(AGENTS, value);

function agentList(value) {
  const agents = [...new Set(String(value).split(",").map((part) => part.trim()).filter(Boolean))];
  const unknown = agents.filter((agent) => !isAgentKind(agent));
  if (agents.length === 0 || unknown.length > 0) throw new Error(`bad agent list "${value}"`);
  return agents;
}

const STOP_REASONS = ["admin", "user", "deactivated", "deleted"];

const settings = {
  maxRunning: Number(env.MAX_RUNNING_WORKSPACES || 4),
  startMs: Number(env.MOCK_START_MS || 1500),
  /** How long a stop through the control API takes (docker stop -t 10 on the real gateway). */
  stopMs: Number(env.MOCK_STOP_MS || 0),
  idleTimeoutMinutes: Number(env.IDLE_TIMEOUT_MINUTES || 30),
  agents: agentList(env.MOCK_AGENTS || "qwen,dsh"),
  /** How long an update's simulated image build takes (an update that uses an image on the server builds none). */
  buildMs: Number(env.MOCK_BUILD_MS || 20_000),
  /** ONLINE_WORKSPACES: Online workspaces exist on this portal at all. */
  online: onOff(env.ONLINE_WORKSPACES || "on"),
};

function onOff(value) {
  if (["on", "1", "true"].includes(value)) return true;
  if (["off", "0", "false"].includes(value)) return false;
  throw new Error(`bad on/off value "${value}"`);
}
const db = new Database(path.join(env.PORTAL_DATA_DIR || "/srv/workspace-portal", "db", "portal.sqlite"), {
  fileMustExist: true,
});
db.pragma("busy_timeout = 5000");

/** The agent a start without one launches, like the gateway's: users.agent if enabled, else the first enabled. */
function preferredAgent(userId) {
  const chosen = db.prepare("SELECT agent FROM users WHERE id = ?").get(userId)?.agent ?? null;
  return chosen !== null && settings.agents.includes(chosen) ? chosen : (settings.agents[0] ?? null);
}

/** WorkspaceInfo.online, as the gateway works it out: the global switch, then the admin's per-user permission. */
function onlineAccess(userId) {
  if (!settings.online) return "off";
  const row = db.prepare("SELECT online_allowed FROM users WHERE id = ?").get(userId);
  return row && row.online_allowed === 0 ? "not_allowed" : "allowed";
}

/** The gateway's refusal of an Online start for this user, or null when it may start. */
function onlineRefusal(userId) {
  const access = onlineAccess(userId);
  if (access === "off") return [409, { error: "online_disabled", message: "Online workspaces are turned off on this portal." }];
  if (access === "not_allowed") {
    return [403, { error: "online_not_allowed", message: "Your administrator hasn't allowed you an Online workspace." }];
  }
  return null;
}

/** @type {Map<number, any>} */
const workspaces = new Map();
const log = [];
/** Control API calls with their JSON bodies, for tests that check what the portal asked for. */
const calls = [];
const live = createMockLive({
  workspaces: () => [...workspaces.keys()].map(info),
  userName: (id) => {
    const row = db.prepare("SELECT first_name, middle_name, last_name FROM users WHERE id = ?").get(id);
    return row ? [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ") : null;
  },
  maxRunning: () => settings.maxRunning,
  memoryLimitBytes: 2304 * 1024 ** 2,
  audit,
});

function info(userId) {
  const w = workspaces.get(userId);
  const now = Date.now();
  const running = w?.status === "running";
  return {
    userId,
    status: w?.status ?? "stopped",
    agent: w?.agent ?? null,
    kind: w?.kind ?? "private",
    online: onlineAccess(userId),
    agentVersion: isActive(w) ? (w.agentVersion ?? null) : null,
    ready: Boolean(running && w.ready),
    startedAt: w?.startedAt ?? null,
    lastActivityAt: w?.lastActivityAt ?? null,
    idleSeconds: running ? Math.floor((now - w.lastActivityAt) / 1000) : null,
    memoryBytes: running ? 412 * 1024 * 1024 + userId * 7 * 1024 * 1024 : null,
    connections: { owner: w?.owner ?? 0, admin: w?.admin ?? 0 },
    llmInFlight: 0,
    busy: Boolean(running && w.busy),
    busyReason: running && w.busy ? "task" : null,
    stopPending: Boolean(running && w.stopPending),
    stopReason: w?.stopReason ?? null,
    lastError: w?.lastError ?? null,
  };
}

function stop(userId, reason) {
  const w = workspaces.get(userId) ?? {};
  workspaces.set(userId, { ...w, status: "stopped", ready: false, busy: false, stopPending: false, stopReason: reason, admin: 0, owner: 0 });
}

const isActive = (w) => w?.status === "running" || w?.status === "starting";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The request's JSON object body: {} when empty, null when it isn't a JSON object. */
async function readBody(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function countSessionsUsing(userId) {
  return db
    .prepare(
      `SELECT count(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ? AND u.active = 1 AND (
         (s.user_id = ? AND (s.acting_as_user_id IS NULL OR s.acting_as_user_id = ?))
         OR (s.acting_as_user_id = ? AND u.role = 'admin'))`,
    )
    .get(Date.now(), userId, userId, userId).n;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function control(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "__mock") {
    log.push(`${req.method} ${url.pathname}${url.search}`);
    if (parts[1] === "log") return send(res, 200, { log, calls });
    if (parts[1] === "agents") return send(res, 200, agentHook(parts[2], url.searchParams));
    if (parts[1] === "live" || parts[1] === "engine") return send(res, 200, live.hook(parts[1], url.searchParams));
    if (parts[1] === "registry") {
      if (url.searchParams.has("down")) registry.setDown(url.searchParams.get("down") === "1");
      if (url.searchParams.get("known") === "0") registry.forget();
      return send(res, 200, registry.snapshot());
    }
    if (parts[1] === "config") {
      for (const key of ["maxRunning", "startMs", "stopMs", "buildMs"]) {
        if (url.searchParams.has(key)) settings[key] = Number(url.searchParams.get(key));
      }
      if (url.searchParams.has("agents")) settings.agents = agentList(url.searchParams.get("agents"));
      if (url.searchParams.has("online")) {
        settings.online = onOff(url.searchParams.get("online"));
        // As a gateway that starts with ONLINE_WORKSPACES=off: running Online workspaces are stopped.
        if (!settings.online) {
          for (const [id, w] of workspaces) if (isActive(w) && w.kind === "online") stop(id, "online_disabled");
        }
      }
      return send(res, 200, settings);
    }
    const id = Number(parts[2]);
    if (parts[3] === "stop") stop(id, url.searchParams.get("reason") || "idle");
    if (parts[3] === "connections") {
      const counts = {};
      for (const key of ["admin", "owner"]) {
        if (url.searchParams.has(key)) counts[key] = Number(url.searchParams.get(key));
      }
      workspaces.set(id, { ...workspaces.get(id), ...counts });
    }
    if (parts[3] === "error") {
      const message = url.searchParams.get("message") || "The workspace exited during start.";
      workspaces.set(id, { ...workspaces.get(id), status: "error", ready: false, busy: false, lastError: message, admin: 0, owner: 0 });
    }
    if (parts[3] === "kind") {
      const kind = url.searchParams.get("kind");
      if (!isWorkspaceKind(kind)) return send(res, 400, { error: "unknown_kind", message: `There is no kind "${kind}".` });
      workspaces.set(id, { ...workspaces.get(id), kind });
    }
    if (parts[3] === "busy") {
      const on = url.searchParams.get("on") === "1";
      workspaces.set(id, { ...workspaces.get(id), busy: on, ...(on ? {} : { stopPending: false }) });
    }
    return send(res, 200, info(id));
  }

  if (req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: "unauthorized", message: "Bad token" });
  log.push(`${req.method} ${url.pathname}`);
  if (parts[0] !== "control") return send(res, 404, { error: "not_found", message: "Not found" });

  if (parts[1] === "health") return send(res, 200, { ok: true });
  if (parts[1] === "agents") return agentRoutes(req, res, url, parts.slice(2));
  if (parts[1] === "live" || parts[1] === "engine") {
    const body = req.method === "POST" ? await readBody(req) : null;
    if (body) calls.push({ method: req.method, path: url.pathname, body });
    const answer = await live.route(req.method, parts, body, res);
    return answer && send(res, answer[0], answer[1]);
  }
  if (parts[1] === "stats") {
    const running = [...workspaces.values()].filter((w) => w.status === "running").length;
    return send(res, 200, {
      running,
      maxRunning: settings.maxRunning,
      idleTimeoutMinutes: settings.idleTimeoutMinutes,
      memTotalBytes: 128 * 1024 ** 3,
      memAvailableBytes: 97.3 * 1024 ** 3,
      cpus: 32,
      llm: { inFlight: 1, queued: 0, maxConcurrency: 3 },
    });
  }
  if (parts[1] === "sessions" && parts[3] === "disconnect") return send(res, 200, { closed: 0 });
  if (parts[1] !== "workspaces") return send(res, 404, { error: "not_found", message: "Not found" });
  if (parts.length === 2) return send(res, 200, { workspaces: [...workspaces.keys()].map(info) });

  const id = Number(parts[2]);
  const action = parts[3];
  if (req.method === "GET" && !action) return send(res, 200, info(id));
  if (req.method === "DELETE" && action === "data") {
    workspaces.delete(id);
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && action === "files") return eraseFiles(req, res, url, id);
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed", message: "Method not allowed" });
  const body = await readBody(req);
  calls.push({ method: req.method, path: url.pathname, body });
  if (body === null) return send(res, 400, { error: "invalid_json", message: "The body must be a JSON object." });
  if (action === "attach") {
    // Like the gateway: a starting or running workspace's pending stop is off; never starts one.
    const w = workspaces.get(id);
    if (isActive(w)) w.stopPending = false;
    return send(res, 200, info(id));
  }
  if (action === "stop") {
    const reason = body.reason ?? "admin";
    if (!STOP_REASONS.includes(reason)) return send(res, 400, { error: "invalid_reason", message: `Unknown reason "${reason}".` });
    const w = workspaces.get(id);
    if (isActive(w) && settings.stopMs > 0) {
      workspaces.set(id, { ...w, status: "stopping", ready: false });
      await sleep(settings.stopMs);
    }
    stop(id, reason);
    return send(res, 200, info(id));
  }
  if (action === "release") {
    const w = workspaces.get(id);
    if (countSessionsUsing(id) === 0 && w?.status === "running") {
      // Like the real gateway: a busy agent finishes its task first, then the workspace stops.
      if (w.busy) workspaces.set(id, { ...w, stopPending: true });
      else stop(id, "logout");
    }
    return send(res, 200, info(id));
  }
  if (action === "start") {
    const requested = body.agent;
    if (requested !== undefined && !isAgentKind(requested)) {
      return send(res, 400, { error: "unknown_agent", message: `There is no agent "${requested}".` });
    }
    if (body.kind !== undefined && !isWorkspaceKind(body.kind)) {
      return send(res, 400, { error: "unknown_kind", message: 'kind must be "private" or "online".' });
    }
    const unavailable = (agent) =>
      send(res, 400, { error: "agent_unavailable", message: `${AGENTS[agent].name} isn't enabled on this server.` });
    if (requested !== undefined && !settings.agents.includes(requested)) return unavailable(requested);
    const current = workspaces.get(id);
    if (isActive(current)) {
      // Without a kind: attach to whichever kind runs. Naming the other one is refused, like another agent.
      if (body.kind !== undefined && body.kind !== (current.kind ?? "private")) {
        const message = `Your ${KIND_NAMES[current.kind ?? "private"]} workspace is running. Stop it to start the ${KIND_NAMES[body.kind]} one.`;
        return send(res, 409, { error: "kind_mismatch", message });
      }
      if (requested !== undefined && requested !== current.agent) {
        const message = `${AGENTS[current.agent].name} is already running in this workspace. Stop it to switch.`;
        return send(res, 409, { error: "agent_mismatch", message });
      }
      // Someone is using it again: a stop that waited for the agent to finish is off.
      workspaces.set(id, { ...current, stopPending: false });
    } else {
      const kind = body.kind ?? "private";
      const refusal = kind === "online" ? onlineRefusal(id) : null;
      if (refusal) return send(res, ...refusal);
      // No agent named: the user's harness from Settings while it is enabled, else the first enabled agent.
      const agent = requested ?? preferredAgent(id);
      if (!agent) return send(res, 400, { error: "agent_unavailable", message: "No agent is enabled on this server." });
      if (!settings.agents.includes(agent)) return unavailable(agent);
      const running = [...workspaces.values()].filter(isActive).length;
      if (running >= settings.maxRunning) {
        return send(res, 409, { error: "capacity", message: "All workspace slots are busy." });
      }
      const now = Date.now();
      workspaces.set(id, {
        ...current,
        status: "starting",
        agent,
        kind,
        agentVersion: agentVersions.current[agent],
        ready: false,
        startedAt: now,
        lastActivityAt: now,
        stopReason: null,
        lastError: null,
      });
      setTimeout(() => {
        const w = workspaces.get(id);
        // Only this start: a stop and a new start in between have their own timer.
        if (w?.status === "starting" && w.startedAt === now) workspaces.set(id, { ...w, status: "running", ready: true });
      }, settings.startMs);
    }
    // Like the real gateway, answer right away; the caller polls GET /control/workspaces/:id until ready.
    return send(res, 200, info(id));
  }
  return send(res, 404, { error: "not_found", message: "Not found" });
}

/** DELETE /control/workspaces/:id/files?kind=: body { actorUserId? }; the gateway's checks and audit entry. */
async function eraseFiles(req, res, url, id) {
  const body = await readBody(req);
  calls.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
  if (body === null) return send(res, 400, { error: "invalid_json", message: "The body must be a JSON object." });
  const kind = url.searchParams.get("kind");
  if (!isWorkspaceKind(kind)) return send(res, 400, { error: "unknown_kind", message: 'kind must be "private" or "online".' });
  const { actorUserId } = body;
  if (actorUserId !== undefined && actorUserId !== null && !(Number.isSafeInteger(actorUserId) && actorUserId > 0)) {
    return send(res, 400, { error: "invalid_actor", message: "actorUserId must be a positive integer." });
  }
  if (!db.prepare("SELECT id FROM users WHERE id = ?").get(id)) return send(res, 404, { error: "user_not_found", message: "No such user." });
  const w = workspaces.get(id);
  if ((isActive(w) || w?.status === "stopping") && (w.kind ?? "private") === kind) {
    return send(res, 409, {
      error: "workspace_running",
      message: `The ${KIND_NAMES[kind]} workspace is running. Stop it before erasing its files.`,
    });
  }
  audit("workspace_files_erased", actorUserId ?? null, { kind }, id);
  return send(res, 200, { ok: true });
}

// ---- Agent versions ------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const T0 = Date.now();

/** A Qwen Code release's notes, as its GitHub releases are written (the section is there even without any). */
const qwenNotes = (highlights, breaking = "No known breaking changes.") =>
  [
    "<!-- qwen-release-notes:v1 -->",
    "",
    "## Highlights",
    "",
    ...highlights.map((line) => `- ${line}`),
    "",
    "## Breaking Changes",
    "",
    breaking,
    "",
    "## Complete Change List",
    "",
    "### Features",
    "",
    "- feat(cli): show the session's token use in the footer ([#16490](https://github.com/QwenLM/qwen-code/pull/16490))",
    "- feat(core): read `.qwenignore` in nested folders ([#16471](https://github.com/QwenLM/qwen-code/pull/16471))",
    "",
    "### Fixes",
    "",
    "- fix(mcp): reconnect after the server restarts ([#16482](https://github.com/QwenLM/qwen-code/pull/16482))",
    "- fix(tools): keep the file's line endings on edit ([#16477](https://github.com/QwenLM/qwen-code/pull/16477))",
  ].join("\n");

/**
 * What the npm registry and GitHub have: each package's dist-tags, its versions with their publish times (days
 * ago) and deprecation, and the release notes of the versions the repository has a release for.
 */
const RELEASES = {
  qwen: {
    distTags: { latest: "0.27.4", preview: "0.28.0-preview.0", nightly: "0.28.0-nightly.20261115.6e3b2dcc19", jobbench: "0.0.0-jobbench.3" },
    versions: [
      ["0.25.0", 71],
      ["0.26.0", 42],
      ["0.27.0", 21],
      ["0.27.1", 14],
      ["0.27.2", 9],
      ["0.27.3", 5],
      ["0.27.4", 2],
      ["0.28.0-preview.0", 1],
      ["0.28.0-nightly.20261115.6e3b2dcc19", 0.5],
      ["0.0.0-jobbench.3", 30],
    ],
    notes: {
      "0.27.4": qwenNotes(["**Faster start**: extensions load when first used.", "Fixes the `/resume` picker on narrow terminals."]),
      "0.27.3": qwenNotes(["MCP servers reconnect by themselves after a restart."]),
      "0.27.2": qwenNotes(
        ["Dependencies upgraded, Node 22 or newer required.", "New `/usage` command."],
        "- fix(deps)!: upgrade dependencies; Node 20 is no longer supported ([#16452](https://github.com/QwenLM/qwen-code/pull/16452))",
      ),
      "0.27.1": qwenNotes(["Edits keep the file's line endings."]),
      "0.27.0": qwenNotes(["**Session footer** with the token use.", "`.qwenignore` in nested folders."]),
    },
    tag: (version) => `v${version}`,
    repo: "QwenLM/qwen-code",
  },
  dsh: {
    distTags: { latest: "0.2.2-rc.1", next: "0.2.2-rc.3" },
    versions: [
      ["0.1.5-rc.3", 74],
      ["0.1.7-rc.1", 60],
      ["0.1.7-rc.2", 55],
      ["0.2.0-rc.2", 44],
      ["0.2.1-rc.4", 33],
      ["0.2.1-rc.5", 30],
      ["0.2.2-rc.1", 8],
      ["0.2.2-rc.2", 5],
      ["0.2.2-rc.3", 2],
    ],
    notes: {
      "0.2.2-rc.1": [
        "## What's Changed",
        "- Sessions resume after a restart of the harness by @deepseek-dev",
        "- `dsh serve` answers health checks before the model is warm by @deepseek-dev",
        "",
        "**Full Changelog**: https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.5...dsh-v0.2.2-rc.1",
      ].join("\n"),
    },
    tag: (version) => `dsh-v${version}`,
    repo: "deepseek-ai/deepseek-harness",
  },
};
/** The gateway's hasBreakingChanges as far as the notes above need it: a `type!:` list entry. */
const breakingIn = (body) => /^- [a-z]+(?:\([^)]*\))?!:/m.test(body);
const published = (kind) => RELEASES[kind].versions.map(([version]) => version);
const isVersion = (value) => typeof value === "string" && value.length <= 100 && /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?$/.test(value);
const workspaceImage = (kind, version) => `workspace-portal/workspace:${kind}-${version}`;
const GiB = 1024 ** 3;

/** Semver precedence, prereleases included (a release sorts after its prereleases). */
function compareVersions(a, b) {
  const parse = (version) => {
    const dash = version.indexOf("-");
    return {
      core: (dash < 0 ? version : version.slice(0, dash)).split(".").map(Number),
      pre: dash < 0 ? [] : version.slice(dash + 1).split("."),
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

/** The npm registry as the gateway's release cache sees it: answers cached, an outage keeps the last answer. */
const registry = {
  down: false,
  /** False until it answered once: the releases' dates and notes, and latest, are unknown. */
  known: true,
  checkedAt: Date.now(),
  error: null,
  setDown(down) {
    this.down = down;
    this.error = down ? "The npm registry is unreachable (fetch failed)." : null;
    if (!down) Object.assign(this, { known: true, checkedAt: Date.now() });
  },
  forget() {
    Object.assign(this, { known: false, checkedAt: null });
  },
  /** GET /control/agents/versions: asks again every 10 minutes, or at once with ?refresh=1 (taking a moment). */
  async check(refresh) {
    const stale = !this.down && Date.now() - (this.checkedAt ?? 0) > 10 * 60_000;
    if (!refresh && !stale) return;
    await sleep(700);
    if (this.down) this.error = "The npm registry is unreachable (fetch failed).";
    else Object.assign(this, { known: true, checkedAt: Date.now(), error: null });
  },
  /**
   * The gateway's offeredReleases: the 5 newest stable releases (no prerelease but latest itself, none deprecated,
   * none newer than latest), filled up for a prerelease latest with the newest prerelease of its kind per earlier
   * version line, and every version in `keep`, newest first. Unknown registry: `keep` only.
   */
  releases(kind, keep) {
    const { distTags, versions, notes, tag, repo } = RELEASES[kind];
    const latest = this.known ? distTags.latest : null;
    const stable = this.known
      ? versions
          .map(([version]) => version)
          .filter((version) => version === latest || (/^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, latest) <= 0))
          .sort((a, b) => compareVersions(b, a))
          .slice(0, 5)
      : [];
    const channel = latest && /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(latest)?.[1];
    if (channel) {
      const line = (version) => version.replace(/[-+].*$/, "");
      const lines = new Set(stable.map(line));
      for (const [version] of [...versions].sort(([a], [b]) => compareVersions(b, a))) {
        if (stable.length >= 5) break;
        if (lines.has(line(version)) || compareVersions(version, latest) > 0) continue;
        if (/^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(version)?.[1] !== channel) continue;
        lines.add(line(version));
        stable.push(version);
      }
    }
    const times = new Map(versions.map(([version, daysAgo]) => [version, Math.round(T0 - daysAgo * DAY)]));
    return [...new Set([...stable, ...keep])]
      .sort((a, b) => compareVersions(b, a))
      .map((version) => {
        const body = this.known ? notes[version] : undefined;
        return {
          version,
          publishedAt: this.known ? (times.get(version) ?? null) : null,
          latest: version === latest,
          notes:
            body === undefined
              ? null
              : {
                  title: tag(version),
                  url: `https://github.com/${repo}/releases/tag/${tag(version)}`,
                  publishedAt: times.get(version) ?? null,
                  body,
                  breaking: breakingIn(body),
                },
        };
      });
  },
  snapshot() {
    return { down: this.down, known: this.known, checkedAt: this.checkedAt, error: this.error };
  },
};

/** Versions, images and the update job: the gateway's AgentVersions, Docker's images and the AgentUpdater. */
const agentVersions = {
  /** The version new workspaces of each agent start with. */
  current: {},
  /** Docker's workspace images: "<kind>-<version>" → { kind, version, sizeBytes, createdAt }. */
  images: new Map(),
  /** The running job, else the last finished one. */
  job: null,
  /** An update request still being checked against the registry: it counts as running. */
  pending: null,
  /** The running job's simulated build. */
  timers: [],
  /** The next job fails at its last build step: { message } (null message: the default failure). */
  failNext: null,
};

function addImage(kind, version, sizeBytes, createdAt) {
  agentVersions.images.set(`${kind}-${version}`, { kind, version, sizeBytes, createdAt });
}

function resetAgentVersions() {
  stopBuild();
  const now = Date.now();
  Object.assign(agentVersions, {
    current: { qwen: AGENTS.qwen.defaultVersion, dsh: AGENTS.dsh.defaultVersion },
    images: new Map(),
    job: null,
    pending: null,
    failNext: null,
  });
  addImage("qwen", "0.27.0", 2.31 * GiB, now - 6 * DAY);
  addImage("qwen", "0.26.0", 2.27 * GiB, now - 24 * DAY);
  addImage("dsh", "0.2.2-rc.1", 2.64 * GiB, now - 3 * DAY);
  addImage("dsh", "0.2.1-rc.5", 2.61 * GiB, now - 29 * DAY);
}
resetAgentVersions();

const jobActive = () => agentVersions.job?.phase === "building" || agentVersions.job?.phase === "verifying";
const jobSnapshot = () => (agentVersions.job ? { ...agentVersions.job, log: [...agentVersions.job.log] } : null);

/** An audit entry, as the gateway writes it (`targetUserId`: the workspace's user, when it is about one). */
function audit(action, actorUserId, details, targetUserId = null) {
  db.prepare("INSERT INTO audit_log (at, actor_user_id, target_user_id, action, details) VALUES (?, ?, ?, ?, ?)").run(
    Date.now(),
    actorUserId,
    targetUserId,
    action,
    JSON.stringify(details),
  );
}

function versionInfo(kind) {
  const { name, packageName, defaultVersion } = AGENTS[kind];
  const current = agentVersions.current[kind];
  const latest = registry.known ? RELEASES[kind].distTags.latest : null;
  const counts = new Map();
  for (const w of workspaces.values()) {
    if (w.agent === kind && isActive(w)) counts.set(w.agentVersion ?? null, (counts.get(w.agentVersion ?? null) ?? 0) + 1);
  }
  const installed = [...agentVersions.images.values()]
    .filter((image) => image.kind === kind)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(({ version, sizeBytes, createdAt }) => ({
      version,
      image: workspaceImage(kind, version),
      sizeBytes: Math.round(sizeBytes),
      createdAt,
      current: version === current,
      inUse: counts.get(version) ?? 0,
    }));
  const running = [...counts]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : compareVersions(b, a)))
    .map(([version, count]) => ({ version, count }));
  return {
    id: kind,
    name,
    packageName,
    current,
    defaultVersion,
    latest,
    updateAvailable: latest !== null && compareVersions(latest, current) > 0,
    releases: registry.releases(kind, [current, ...installed.map((image) => image.version)]),
    installed,
    running,
  };
}

function versionsOverview() {
  return {
    agents: settings.agents.map(versionInfo),
    job: jobSnapshot(),
    registryError: registry.error,
    checkedAt: registry.checkedAt,
  };
}

/** The build steps of an agent's image, like `docker build --progress=plain` shows them: the base layers cached unless from scratch. */
function buildSteps(kind, version, rebuild) {
  const { packageName, cli } = AGENTS[kind];
  const base = (name, lines) => ({ name, lines: rebuild ? lines : [], cached: !rebuild, weight: rebuild ? 3 : 0.1 });
  const check =
    kind === "dsh"
      ? "RUN dsh --profile web --patch /usr/local/share/workspace-portal/dsh/lockdown.patch.yml --dump-config"
      : `RUN ${cli} --version`;
  return [
    { name: "[internal] load build definition from Dockerfile", lines: ["transferring dockerfile: 7.40kB done"], weight: 0.3 },
    { name: "[internal] load metadata for docker.io/library/node:24-bookworm-slim", lines: [], weight: 0.8 },
    {
      name: "[base 1/5] FROM docker.io/library/node:24-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4",
      lines: [],
      weight: 0.2,
    },
    base(
      "[base 2/5] RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq less procps ripgrep tini unzip python3 python3-venv chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*",
      [
        "Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]",
        "Get:2 http://deb.debian.org/debian bookworm-updates InRelease [55.4 kB]",
        "Get:3 http://deb.debian.org/debian-security bookworm-security InRelease [48.0 kB]",
        "Get:4 http://deb.debian.org/debian bookworm/main amd64 Packages [8792 kB]",
        "Fetched 9246 kB in 2s (4512 kB/s)",
        "Reading package lists...",
        "The following NEW packages will be installed:",
        "  chromium chromium-common fonts-liberation fonts-noto-color-emoji fonts-noto-core git jq less procps python3 ripgrep tini unzip",
        "0 upgraded, 214 newly installed, 0 to remove and 0 not upgraded.",
        "Need to get 187 MB of archives.",
        "Get:58 http://deb.debian.org/debian-security bookworm-security/main amd64 chromium amd64 142.0.7444.162-1~deb12u1 [79.3 MB]",
        "Setting up chromium (142.0.7444.162-1~deb12u1) ...",
        "Processing triggers for libc-bin (2.36-9+deb12u13) ...",
      ],
    ),
    base('[base 3/5] RUN npm install -g --no-fund --no-audit "@playwright/mcp@0.0.84" && npm cache clean --force', ["added 22 packages in 4s"]),
    base("[base 4/5] RUN mkdir -p /home/user /workspace && (userdel --remove node 2>/dev/null || true)", []),
    base("[base 5/5] WORKDIR /workspace", []),
    { name: "[internal] load build context", lines: ["transferring context: 376B done"], weight: 0.2 },
    {
      name: `[${kind} 1/3] RUN npm install -g --no-fund --no-audit "${packageName}@${version}" && npm cache clean --force`,
      lines: [
        "npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead",
        "",
        `added ${kind === "dsh" ? 671 : 412} packages in 21s`,
        "npm warn using --force Recommended protections disabled.",
      ],
      weight: 6,
    },
    { name: `[${kind} 2/3] COPY --chmod=0755 start-${kind}.sh /usr/local/bin/start-${kind}`, lines: [], weight: 0.3 },
    { name: `[${kind} 3/3] ${check}`, lines: [], weight: 1.5 },
    {
      name: "exporting to image",
      lines: [
        "exporting layers 3.2s done",
        `writing image sha256:${crypto.createHash("sha256").update(`${kind}-${version}-${Date.now()}`).digest("hex")} done`,
        `naming to docker.io/workspace-portal/workspace-build:${kind}-${version} done`,
      ],
      weight: 1,
    },
  ];
}

/** What a failing build shows at its last step, and the error the job ends with. */
function failureOf(kind, version, message) {
  if (message) return { lines: [message], error: message };
  if (kind === "dsh") {
    return {
      lines: [
        `lockdown.patch.yml does not fit dsh ${version} (exit 0):`,
        'dsh: [/usr/local/share/workspace-portal/dsh/lockdown.patch.yml] patch: entry "account-controller" not found',
      ],
      error:
        'process "/bin/sh -c dsh --profile web --patch /usr/local/share/workspace-portal/dsh/lockdown.patch.yml --dump-config" did not complete successfully: exit code: 1',
    };
  }
  return {
    lines: ["Error: Cannot find module '@qwen-code/qwen-code-core/dist/index.js'", "Node.js v24.11.1"],
    error: 'process "/bin/sh -c qwen --version" did not complete successfully: exit code: 1',
  };
}

function stopBuild() {
  for (const timer of agentVersions.timers) clearTimeout(timer);
  agentVersions.timers = [];
}

function finishJob(phase, error) {
  stopBuild();
  Object.assign(agentVersions.job, { phase, error, step: null, finishedAt: Date.now() });
}

/**
 * A version whose image is here (the current one included), not from scratch: no registry query and no build, only
 * the check (as the gateway).
 */
const reusesImage = (kind, version, rebuild) => !rebuild && agentVersions.images.has(`${kind}-${version}`);

/**
 * The version check, then the job's version is current: the whole job when it uses the image on the server
 * (built: false, logged first as the gateway does), a build's last phase.
 */
function verifyAndPromote(job, at, { built }) {
  const { agent: kind, version, rebuild, actorUserId } = job;
  const { cli } = AGENTS[kind];
  if (!built) job.log.push(`Using the image already on this server (${workspaceImage(kind, version)}).`);
  Object.assign(job, { phase: "verifying", step: `${cli} --version` });
  at(1450, () => {
    job.log.push(`${cli} --version: ${version}`);
    const previous = agentVersions.images.get(`${kind}-${version}`);
    if (built) addImage(kind, version, previous?.sizeBytes ?? (kind === "dsh" ? 2.66 : 2.33) * GiB, Date.now());
    agentVersions.current[kind] = version;
    finishJob("succeeded", null);
    audit("agent_updated", actorUserId, { agent: kind, from: job.fromVersion, to: version, rebuild });
  });
}

/** Plays the build: each step's header, its output spread over its share of the time, then DONE or CACHED. */
function startJob(kind, version, rebuild, actorUserId) {
  const job = {
    id: crypto.randomUUID(),
    agent: kind,
    fromVersion: agentVersions.current[kind],
    version,
    rebuild,
    reuse: reusesImage(kind, version, rebuild),
    actorUserId,
    phase: "building",
    step: null,
    log: [],
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  agentVersions.job = job;
  const at = (ms, action) => agentVersions.timers.push(setTimeout(action, ms));
  if (job.reuse) {
    verifyAndPromote(job, at, { built: false });
    return job;
  }
  const failure = agentVersions.failNext ? failureOf(kind, version, agentVersions.failNext.message) : null;
  agentVersions.failNext = null;
  const steps = buildSteps(kind, version, rebuild);
  const failAt = failure ? steps.findIndex((step) => step.name.startsWith(`[${kind} 3/3]`)) : -1;
  const total = settings.buildMs;
  const weights = steps.reduce((sum, step) => sum + step.weight, 0);
  /** The job keeps the last 200 lines, like the gateway's. */
  const append = (line) => {
    job.log.push(line);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };

  let clock = 0;
  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    const duration = (total * step.weight) / weights;
    const lines = index === failAt ? failure.lines : step.lines;
    at(clock, () => {
      job.step = step.name;
      append(`#${n} ${step.name}`);
    });
    lines.forEach((line, i) => {
      const offset = (duration * (i + 1)) / (lines.length + 1);
      at(clock + offset, () => append(`#${n} ${(offset / 1000).toFixed(2)} ${line}`.trimEnd()));
    });
    clock += duration;
    if (index === failAt) {
      at(clock, () => {
        append(`#${n} ERROR: ${failure.error}`);
        finishJob("failed", failure.error);
        audit("agent_update_failed", actorUserId, { agent: kind, version, error: failure.error });
      });
      return job;
    }
    at(clock, () => append(step.cached ? `#${n} CACHED` : `#${n} DONE ${(duration / 1000).toFixed(1)}s`));
  }
  at(clock + 50, () => verifyAndPromote(job, at, { built: true }));
  return job;
}

/** An exact version the registry has; else the gateway's refusal. */
async function resolveVersion(kind, requested) {
  const { name, packageName } = AGENTS[kind];
  if (!isVersion(requested)) return { status: 400, error: "invalid_version", message: `"${requested}" is not a version (like 0.27.4).` };
  await sleep(300);
  if (registry.down) return { status: 502, error: "registry_unreachable", message: "The npm registry is unreachable (fetch failed)." };
  if (published(kind).includes(requested)) return { version: requested };
  return { status: 404, error: "version_not_found", message: `${name} ${requested} is not published (${packageName}).` };
}

const unknownAgent = { status: 400, error: "unknown_agent", message: `agent must be one of ${Object.keys(AGENTS).map((kind) => `"${kind}"`).join(", ")}.` };

/** POST /control/agents/:agent/update: refusals in the gateway's order, then the job as it starts. */
async function startUpdate(kind, body) {
  if (!isAgentKind(kind)) return unknownAgent;
  if (body === null) return { status: 400, error: "bad_request", message: "The body must be a JSON object." };
  const { version, rebuild, actorUserId } = body;
  if (typeof version !== "string" || version.trim() === "" || version.length > 128) {
    return { status: 400, error: "bad_request", message: "version must be a version, like 0.27.4." };
  }
  if (rebuild !== undefined && rebuild !== null && typeof rebuild !== "boolean") {
    return { status: 400, error: "bad_request", message: "rebuild must be true or false." };
  }
  if (actorUserId !== undefined && actorUserId !== null) {
    if (!(Number.isSafeInteger(actorUserId) && actorUserId > 0)) return { status: 400, error: "invalid_actor", message: "actorUserId must be a positive integer." };
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(actorUserId)) {
      return { status: 400, error: "invalid_actor", message: `actorUserId ${actorUserId} is not a user.` };
    }
  }
  if (!settings.agents.includes(kind)) return { status: 400, error: "agent_unavailable", message: `${AGENTS[kind].name} is not available on this portal.` };
  if (agentVersions.pending || jobActive()) {
    const job = jobActive() ? agentVersions.job : null;
    const message = job
      ? `${AGENTS[job.agent].name} is being updated to ${job.version}. Wait for it to finish, or cancel it.`
      : "An agent update is already running. Wait for it to finish, or cancel it.";
    return { status: 409, error: "update_running", message };
  }
  agentVersions.pending = kind;
  try {
    const requested = version.trim();
    const resolved = reusesImage(kind, requested, rebuild === true) ? { version: requested } : await resolveVersion(kind, requested);
    if (!resolved.version) return resolved;
    startJob(kind, resolved.version, rebuild === true, actorUserId ?? null);
    return { status: 200, body: jobSnapshot() };
  } finally {
    agentVersions.pending = null;
  }
}

/** POST /control/agents/update/cancel: the build stops, and the job is cancelled a moment later. */
function cancelUpdate() {
  if (!jobActive()) return false;
  const job = agentVersions.job;
  stopBuild();
  agentVersions.timers.push(
    setTimeout(() => {
      finishJob("cancelled", "Cancelled");
      audit("agent_update_failed", job.actorUserId, { agent: job.agent, version: job.version, error: "Cancelled" });
    }, 800),
  );
  return true;
}

/** DELETE /control/agents/:agent/images/:version. */
function removeImage(kind, version) {
  if (!isAgentKind(kind)) return unknownAgent;
  const { name } = AGENTS[kind];
  if (!isVersion(version)) return { status: 400, error: "invalid_version", message: `"${version}" is not a version (like 0.27.4).` };
  if (agentVersions.pending === kind || (jobActive() && agentVersions.job.agent === kind)) {
    return { status: 409, error: "update_running", message: `An update of ${name} is running. Wait for it to finish, or cancel it.` };
  }
  if (agentVersions.current[kind] === version) {
    return {
      status: 409,
      error: "image_current",
      message: `${name} ${version} is the current version: new workspaces start from this image. Switch to another version first.`,
    };
  }
  const image = workspaceImage(kind, version);
  if (!agentVersions.images.has(`${kind}-${version}`)) return { status: 404, error: "not_found", message: `There is no image ${image}.` };
  const inUse = [...workspaces.values()].some((w) => isActive(w) && w.agent === kind && w.agentVersion === version);
  if (inUse) {
    return { status: 409, error: "image_in_use", message: `${image} is in use by a workspace container. It can be removed once that workspace has stopped.` };
  }
  agentVersions.images.delete(`${kind}-${version}`);
  return { status: 200, body: { ok: true } };
}

/** /control/agents and below. */
async function agentRoutes(req, res, url, rest) {
  const reply = (result) => (result.status === 200 ? send(res, 200, result.body) : send(res, result.status, { error: result.error, message: result.message }));
  if (rest.length === 0 && req.method === "GET") {
    return send(res, 200, { agents: settings.agents.map((id) => ({ ...pick(AGENTS[id], ["id", "name", "description"]), version: agentVersions.current[id] })) });
  }
  if (rest.length === 1 && rest[0] === "versions" && req.method === "GET") {
    await registry.check(url.searchParams.get("refresh") === "1");
    return send(res, 200, versionsOverview());
  }
  if (rest.length === 2 && rest[0] === "update" && rest[1] === "cancel" && req.method === "POST") {
    calls.push({ method: req.method, path: url.pathname, body: null });
    return send(res, 200, { cancelled: cancelUpdate() });
  }
  if (rest.length === 2 && rest[1] === "update" && req.method === "POST") {
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, body });
    return reply(await startUpdate(rest[0], body));
  }
  if (rest.length === 3 && rest[1] === "images" && req.method === "DELETE") {
    calls.push({ method: req.method, path: url.pathname, body: null });
    return reply(removeImage(rest[0], decodeURIComponent(rest[2])));
  }
  return send(res, 404, { error: "not_found", message: "Not found" });
}

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

/** POST /__mock/agents/<hook>. */
function agentHook(hook, params) {
  if (hook === "reset") resetAgentVersions();
  if (hook === "fail-next") agentVersions.failNext = { message: params.get("message") || null };
  if (hook === "drop-image") agentVersions.images.delete(`${params.get("agent")}-${params.get("version")}`);
  return { ...versionsOverview(), failNext: agentVersions.failNext };
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    control(req, res, url).catch((error) => send(res, 500, { error: "internal", message: String(error) }));
  })
  .listen(controlPort, "127.0.0.1", () => console.log(`mock control API on 127.0.0.1:${controlPort}`));

/** The session's id (the cookie token's hash) and the workspace it uses, or null when signed out. */
function sessionTarget(cookieHeader) {
  const match = /(?:^|;\s*)portal_session=([^;]+)/.exec(cookieHeader || "");
  if (!match) return null;
  const hash = crypto.createHash("sha256").update(decodeURIComponent(match[1])).digest("hex");
  const row = db
    .prepare(
      `SELECT s.user_id, s.acting_as_user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(hash, Date.now());
  if (!row) return null;
  const targetId = row.role === "admin" && row.acting_as_user_id ? row.acting_as_user_id : row.user_id;
  const target = db.prepare("SELECT id, username FROM users WHERE id = ?").get(targetId);
  return target ? { ...target, sessionId: hash } : null;
}

/** The gateway's agentBrowserToken (@portal/db): the iframe's fragment must carry this one for the port's kind. */
const browserToken = (sessionId, userId, kind) =>
  crypto.createHmac("sha256", secret).update(`workspace-portal/agent-token/v2\n${sessionId}\n${userId}\n${kind}`).digest("base64url");

/**
 * One workspace port: the port says the user and the kind. Its own kind starting or running shows the mock
 * workspace (and whether the fragment's token is this session's for this kind); the other kind running, or none,
 * shows what the gateway's themed pages say. Nothing starts here, as on the gateway.
 */
function agentPage(kind) {
  const base = kind === "online" ? onlineAgentPortBase : agentPortBase;
  return (req, res) => {
    const userId = req.socket.localPort - base;
    const target = sessionTarget(req.headers.cookie);
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    const w = workspaces.get(userId);
    const runningKind = isActive(w) || w?.status === "stopping" ? (w.kind ?? "private") : null;
    const status = !target ? 401 : target.id !== userId ? 403 : runningKind !== null && runningKind !== kind ? 409 : 200;
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `frame-ancestors http://${host}:* https://${host}:*`,
    });
    const open = status === 200 && runningKind === kind;
    if (open) w.lastActivityAt = Date.now();
    const text =
      status === 401
        ? "Signed out"
        : status === 403
          ? "This workspace isn't open here"
          : status === 409
            ? `Your ${KIND_NAMES[runningKind]} workspace is running, not this one`
            : open
              ? `Mock workspace · ${target.username} (#${target.id}) · ${KIND_NAMES[kind]}`
              : `Your ${KIND_NAMES[kind]} workspace is stopped`;
    const agent = open ? AGENTS[w.agent]?.name : undefined;
    const expected = status === 200 ? browserToken(target.sessionId, userId, kind) : "";
    res.end(`<!doctype html><meta charset="utf-8"><title>Mock workspace</title>
<style>
  html{color-scheme:dark}
  body{margin:0;height:100vh;display:grid;place-items:center;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#0a0a0a;color:#a1a1a1}
</style>
<p id="who">${text}</p>
<p id="kind">${KIND_NAMES[kind]}</p>
<p id="agent">${agent ?? ""}</p>
<p id="token"></p>
<script>
  const token = location.hash.startsWith("#token=") ? location.hash.slice(7) : null;
  document.getElementById("token").textContent = token === null ? "no token" : token === ${JSON.stringify(expected)} ? "token in fragment" : "token in fragment (wrong token for this workspace)";
</script>`);
  };
}

for (const kind of ["private", "online"]) {
  const base = kind === "online" ? onlineAgentPortBase : agentPortBase;
  for (let port = base + 1; port < base + agentPortCount; port++) http.createServer(agentPage(kind)).listen(port, "127.0.0.1");
  console.log(`mock ${kind} workspace ports on 127.0.0.1:${base + 1}-${base + agentPortCount - 1}`);
}
