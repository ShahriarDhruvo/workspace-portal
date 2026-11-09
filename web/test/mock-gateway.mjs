// Test double for the gateway, for local end-to-end runs of the web app. NOT used in production.
// Implements the control API (docs/ARCHITECTURE.md) with in-memory workspace state, plus a tiny
// workspace port per user (AGENT_PORT_BASE + id) that resolves the portal_session cookie like the real proxy,
// refuses sessions using another workspace, and shows whose workspace it is and which agent runs there. Like
// the real gateway, start answers at once with "starting", and the workspace turns "running" and ready startMs
// later. A workspace runs one agent at a time: start takes `{agent}` (without one: the only agent enabled, else
// the last one used, else 400 agent_required), and refuses another agent while one runs (409 agent_mismatch).
//
//   PORTAL_DATA_DIR=... GATEWAY_CONTROL_SECRET=... CONTROL_PORT=4002 AGENT_PORT_BASE=3100 AGENT_PORT_COUNT=20 \
//   MOCK_AGENTS=qwen,dsh node test/mock-gateway.mjs
//
// MOCK_AGENTS (default "qwen,dsh") lists the enabled agents in display order, like the gateway's WORKSPACE_AGENTS.
// Test hooks (no auth): POST /__mock/workspaces/:id/stop?reason=idle,
// POST /__mock/workspaces/:id/connections?admin=N&owner=N, POST /__mock/workspaces/:id/busy?on=1|0,
// POST /__mock/workspaces/:id/error?message=… (a start that failed),
// POST /__mock/config?maxRunning=N&startMs=N&stopMs=N&agents=qwen,dsh, GET /__mock/log (paths in `log`, and
// `calls` with method, path and JSON body).
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";

const env = process.env;
const controlPort = Number(env.CONTROL_PORT || 4002);
const agentPortBase = Number(env.AGENT_PORT_BASE || 3100);
const agentPortCount = Number(env.AGENT_PORT_COUNT || 20);
const secret = env.GATEWAY_CONTROL_SECRET || "";

/** Every agent kind the gateway knows (GET /control/agents lists the enabled ones). */
const AGENTS = {
  qwen: {
    id: "qwen",
    name: "Qwen Code",
    description: "Qwen Code's Web Shell: chat, files, terminal and a headless browser.",
    version: "0.27.0",
  },
  dsh: {
    id: "dsh",
    name: "DeepSeek Harness",
    description: "DeepSeek Harness (dsh): chat, files, terminal and a headless browser.",
    version: "0.2.2-rc.1",
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
};
const db = new Database(path.join(env.PORTAL_DATA_DIR || "/srv/workspace-portal", "db", "portal.sqlite"), {
  fileMustExist: true,
});
db.pragma("busy_timeout = 5000");

/** @type {Map<number, any>} */
const workspaces = new Map();
const log = [];
/** Control API calls with their JSON bodies, for tests that check what the portal asked for. */
const calls = [];

function info(userId) {
  const w = workspaces.get(userId);
  const now = Date.now();
  const running = w?.status === "running";
  return {
    userId,
    status: w?.status ?? "stopped",
    agent: w?.agent ?? null,
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
    if (parts[1] === "config") {
      for (const key of ["maxRunning", "startMs", "stopMs"]) {
        if (url.searchParams.has(key)) settings[key] = Number(url.searchParams.get(key));
      }
      if (url.searchParams.has("agents")) settings.agents = agentList(url.searchParams.get("agents"));
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
  if (parts[1] === "agents") return send(res, 200, { agents: settings.agents.map((id) => AGENTS[id]) });
  if (parts[1] === "stats") {
    const running = [...workspaces.values()].filter((w) => w.status === "running").length;
    return send(res, 200, {
      running,
      maxRunning: settings.maxRunning,
      idleTimeoutMinutes: settings.idleTimeoutMinutes,
      memTotalBytes: 128 * 1024 ** 3,
      memAvailableBytes: 97.3 * 1024 ** 3,
      loadAvg: [0.42, 0.37, 0.31],
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
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed", message: "Method not allowed" });
  const body = await readBody(req);
  calls.push({ method: req.method, path: url.pathname, body });
  if (body === null) return send(res, 400, { error: "invalid_json", message: "The body must be a JSON object." });
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
    const unavailable = (agent) =>
      send(res, 400, { error: "agent_unavailable", message: `${AGENTS[agent].name} isn't enabled on this server.` });
    if (requested !== undefined && !settings.agents.includes(requested)) return unavailable(requested);
    const current = workspaces.get(id);
    if (isActive(current)) {
      if (requested !== undefined && requested !== current.agent) {
        const message = `${AGENTS[current.agent].name} is already running in this workspace. Stop it to switch.`;
        return send(res, 409, { error: "agent_mismatch", message });
      }
      // Someone is using it again: a stop that waited for the agent to finish is off.
      workspaces.set(id, { ...current, stopPending: false });
    } else {
      // No agent named: the only one enabled, else the last one used.
      const agent = requested ?? (settings.agents.length === 1 ? settings.agents[0] : current?.agent);
      if (!agent) return send(res, 400, { error: "agent_required", message: "Choose an agent to start." });
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

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    control(req, res, url).catch((error) => send(res, 500, { error: "internal", message: String(error) }));
  })
  .listen(controlPort, "127.0.0.1", () => console.log(`mock control API on 127.0.0.1:${controlPort}`));

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
  return db.prepare("SELECT id, username FROM users WHERE id = ?").get(targetId) ?? null;
}

function agentPage(req, res) {
  const userId = req.socket.localPort - agentPortBase;
  const target = sessionTarget(req.headers.cookie);
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  const status = !target ? 401 : target.id === userId ? 200 : 403;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `frame-ancestors http://${host}:* https://${host}:*`,
  });
  if (status === 200) {
    const w = workspaces.get(target.id);
    if (w) w.lastActivityAt = Date.now();
  }
  const agent = status === 200 ? AGENTS[workspaces.get(target.id)?.agent]?.name : undefined;
  const text =
    status === 200 ? `Mock workspace · ${target.username} (#${target.id})` : status === 401 ? "Signed out" : "This workspace isn't open here";
  res.end(`<!doctype html><meta charset="utf-8"><title>Mock workspace</title>
<style>
  html{color-scheme:dark}
  body{margin:0;height:100vh;display:grid;place-items:center;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#0a0a0a;color:#a1a1a1}
</style>
<p id="who">${text}</p>
<p id="agent">${agent ?? ""}</p>
<p id="token"></p>
<script>document.getElementById("token").textContent = location.hash.startsWith("#token=") ? "token in fragment" : "no token";</script>`);
}

for (let port = agentPortBase + 1; port < agentPortBase + agentPortCount; port++) {
  http.createServer(agentPage).listen(port, "127.0.0.1");
}
console.log(`mock workspace ports on 127.0.0.1:${agentPortBase + 1}-${agentPortBase + agentPortCount - 1}`);
