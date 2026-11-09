// Test double for the gateway, for local end-to-end runs of the web app. NOT used in production.
// Implements the control API (docs/ARCHITECTURE.md) with in-memory workspace state, plus a tiny
// workspace port per user (AGENT_PORT_BASE + id) that resolves the portal_session cookie like the real proxy,
// refuses sessions using another workspace, and shows whose workspace it is.
//
//   PORTAL_DATA_DIR=... GATEWAY_CONTROL_SECRET=... CONTROL_PORT=4002 AGENT_PORT_BASE=3100 AGENT_PORT_COUNT=20 node test/mock-gateway.mjs
//
// Test hooks (no auth): POST /__mock/workspaces/:id/stop?reason=idle, POST /__mock/workspaces/:id/connections?admin=N,
// POST /__mock/workspaces/:id/busy?on=1|0, POST /__mock/config?maxRunning=N&startMs=N, GET /__mock/log.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";

const env = process.env;
const controlPort = Number(env.CONTROL_PORT || 4002);
const agentPortBase = Number(env.AGENT_PORT_BASE || 3100);
const agentPortCount = Number(env.AGENT_PORT_COUNT || 20);
const secret = env.GATEWAY_CONTROL_SECRET || "";
const settings = {
  maxRunning: Number(env.MAX_RUNNING_WORKSPACES || 4),
  startMs: Number(env.MOCK_START_MS || 1500),
  idleTimeoutMinutes: Number(env.IDLE_TIMEOUT_MINUTES || 30),
};
const db = new Database(path.join(env.PORTAL_DATA_DIR || "/srv/workspace-portal", "db", "portal.sqlite"), {
  fileMustExist: true,
});
db.pragma("busy_timeout = 5000");

/** @type {Map<number, any>} */
const workspaces = new Map();
const log = [];

function info(userId) {
  const w = workspaces.get(userId);
  const now = Date.now();
  const running = w?.status === "running";
  return {
    userId,
    status: w?.status ?? "stopped",
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
  workspaces.set(userId, { ...w, status: "stopped", ready: false, stopReason: reason, admin: 0, owner: 0 });
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
    if (parts[1] === "log") return send(res, 200, { log });
    if (parts[1] === "config") {
      if (url.searchParams.has("maxRunning")) settings.maxRunning = Number(url.searchParams.get("maxRunning"));
      if (url.searchParams.has("startMs")) settings.startMs = Number(url.searchParams.get("startMs"));
      return send(res, 200, settings);
    }
    const id = Number(parts[2]);
    if (parts[3] === "stop") stop(id, url.searchParams.get("reason") || "idle");
    if (parts[3] === "connections") {
      workspaces.set(id, { ...workspaces.get(id), admin: Number(url.searchParams.get("admin") || 0) });
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
  if (action === "stop") {
    let body = "";
    for await (const chunk of req) body += chunk;
    stop(id, JSON.parse(body || "{}").reason ?? "admin");
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
    const current = workspaces.get(id);
    if (current?.stopPending) workspaces.set(id, { ...current, stopPending: false });
    if (current?.status !== "running" && current?.status !== "starting") {
      const running = [...workspaces.values()].filter((w) => w.status === "running" || w.status === "starting").length;
      if (running >= settings.maxRunning) {
        return send(res, 409, { error: "capacity", message: "All workspace slots are busy." });
      }
      const now = Date.now();
      workspaces.set(id, { ...current, status: "starting", ready: false, startedAt: now, lastActivityAt: now, stopReason: null });
      setTimeout(() => {
        const w = workspaces.get(id);
        if (w?.status === "starting") workspaces.set(id, { ...w, status: "running", ready: true });
      }, settings.startMs);
    }
    // Like the real gateway, answer once the workspace is ready.
    const deadline = Date.now() + 90_000;
    while (workspaces.get(id)?.status === "starting" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
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
  const text =
    status === 200 ? `Mock workspace · ${target.username} (#${target.id})` : status === 401 ? "Signed out" : "This workspace isn't open here";
  res.end(`<!doctype html><meta charset="utf-8"><title>Mock workspace</title>
<style>
  html{color-scheme:dark}
  body{margin:0;height:100vh;display:grid;place-items:center;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#0a0a0a;color:#a1a1a1}
</style>
<p id="who">${text}</p>`);
}

for (let port = agentPortBase + 1; port < agentPortBase + agentPortCount; port++) {
  http.createServer(agentPage).listen(port, "127.0.0.1");
}
console.log(`mock workspace ports on 127.0.0.1:${agentPortBase + 1}-${agentPortBase + agentPortCount - 1}`);
