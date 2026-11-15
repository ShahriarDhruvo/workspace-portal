import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { agentWorking, fetchQwenHealth, parseQwenHealth, parseQwenStarted, qwenDriver, type QwenHealth } from "./qwen.ts";

/** A real `GET /health?deep=1` answer of `qwen serve`. */
const REAL_HEALTH = {
  status: "ok",
  workspaceCount: 1,
  sessions: 2,
  pendingPermissions: 1,
  activePrompts: 1,
  activeWork: true,
  activeWorkReporting: true,
  activeWorkStaleMs: 0,
  connectedClients: 3,
  channelAlive: true,
  lastActivityAt: 1_760_000_000_000,
  idleSinceMs: 4_200,
};

const quiet: QwenHealth = { activePrompts: 0, pendingPermissions: 0, activeWork: false, channelAlive: true, idleSinceMs: null };

// ------------------------------------------------------------------ health

test("parseQwenHealth reads the deep health answer", () => {
  assert.deepEqual(parseQwenHealth(REAL_HEALTH), {
    activePrompts: 1,
    pendingPermissions: 1,
    activeWork: true,
    channelAlive: true,
    idleSinceMs: 4_200,
  });
  assert.deepEqual(parseQwenHealth({ status: "ok" }), { ...quiet, channelAlive: false }, "missing fields are zero/false/null");
});

test("parseQwenHealth refuses odd answers and clamps odd figures", () => {
  for (const bad of [null, undefined, "ok", 1, [], { status: "error" }, { ...REAL_HEALTH, status: "degraded" }]) {
    assert.equal(parseQwenHealth(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(
    parseQwenHealth({
      status: "ok",
      activePrompts: -2,
      pendingPermissions: Number.NaN,
      activeWork: "yes",
      connectedClients: "3",
      channelAlive: 1,
      idleSinceMs: -5,
    }),
    { activePrompts: 0, pendingPermissions: 0, activeWork: false, channelAlive: false, idleSinceMs: null },
  );
  assert.equal(parseQwenHealth({ status: "ok", idleSinceMs: 0 })?.idleSinceMs, 0);
  assert.equal(parseQwenHealth({ status: "ok", idleSinceMs: Number.POSITIVE_INFINITY })?.idleSinceMs, null);
});

test("agentWorking: prompts, approvals and reported work are work, however long they have waited", () => {
  assert.equal(agentWorking(quiet), false);
  assert.equal(agentWorking({ ...quiet, activePrompts: 1 }), true);
  assert.equal(agentWorking({ ...quiet, activeWork: true, idleSinceMs: 120 * 60_000 }), true, "a background task");
  // qwen serve declines an unanswered approval itself (--permission-response-timeout-ms); until then it is work.
  assert.equal(agentWorking({ ...quiet, pendingPermissions: 1, idleSinceMs: 120 * 60_000 }), true, "an approval nobody answers");
  assert.equal(agentWorking({ ...quiet, idleSinceMs: 0 }), false, "it just finished");
});

test("fetchQwenHealth sends the token to /health?deep=1 and gives up on odd answers", async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  let reply: (res: http.ServerResponse) => void = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(REAL_HEALTH));
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/health?deep=1");
    seen.push(req.headers);
    reply(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.deepEqual(await fetchQwenHealth({ host: "127.0.0.1", port, credential: "container-token" }), parseQwenHealth(REAL_HEALTH));
    assert.equal(seen[0]!.authorization, "Bearer container-token");
    assert.equal(seen[0]!.accept, "application/json");

    reply = (res) => res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
    assert.equal(await fetchQwenHealth({ host: "127.0.0.1", port, credential: "t" }), null, "401");
    reply = (res) => res.writeHead(500).end(JSON.stringify(REAL_HEALTH));
    assert.equal(await fetchQwenHealth({ host: "127.0.0.1", port, credential: "t" }), null, "a 500 with a healthy-looking body");
    reply = (res) => res.writeHead(200).end("<html>");
    assert.equal(await fetchQwenHealth({ host: "127.0.0.1", port, credential: "t" }), null, "not JSON");
    reply = (res) => res.writeHead(200).end(JSON.stringify({ ...REAL_HEALTH, padding: "x".repeat(100 * 1024) }));
    assert.equal(await fetchQwenHealth({ host: "127.0.0.1", port, credential: "t" }), null, "too large");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await fetchQwenHealth({ host: "127.0.0.1", port, credential: "t" }), null, "connection refused");
});

test("the credential is a fresh 256-bit base64url token per start", () => {
  const a = qwenDriver.generateCredential();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, qwenDriver.generateCredential());
});

test("parseQwenStarted: only a first start that went through counts", () => {
  const status = (preheat: unknown) => ({ v: 1, status: "ok", daemon: { pid: 8, startup: { listenerReadyAt: "2026-11-15T10:30:09.815Z", preheat } } });
  assert.equal(parseQwenStarted(status({ status: "succeeded", durationMs: 1826 })), true);
  for (const state of ["scheduled", "running", "failed", "not_scheduled", "external_bridge", "", 1, null]) {
    assert.equal(parseQwenStarted(status({ status: state })), false, String(state));
  }
  for (const odd of [null, "succeeded", [], {}, { daemon: null }, { daemon: { startup: "succeeded" } }, status(null), status("succeeded")]) {
    assert.equal(parseQwenStarted(odd), false, JSON.stringify(odd));
  }
});

test("probeReady: a live agent process, or one the daemon has started before and put to sleep", async () => {
  const seen: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  let channelAlive = false;
  let preheat: string | null = "running";
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== "Bearer tok") return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health?deep=1") {
      return void res.end(JSON.stringify({ status: "ok", activePrompts: 0, pendingPermissions: 0, activeWork: false, connectedClients: 0, channelAlive, idleSinceMs: null }));
    }
    if (req.url !== "/daemon/status" || preheat === null) return void res.end("not json");
    // The real answer lists every capability: about 107 KB in Qwen Code 0.27.0.
    res.end(JSON.stringify({ v: 1, status: "ok", daemon: { startup: { preheat: { status: preheat } } }, capabilities: "x".repeat(200 * 1024) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const at = (credential: string) => ({ host: "127.0.0.1", port, credential });
  assert.equal(await qwenDriver.probeReady(at("tok")), false, "starting: the daemon answers, its agent process is not up yet");
  preheat = "failed";
  assert.equal(await qwenDriver.probeReady(at("tok")), false, "the agent process could not be started");
  preheat = null;
  assert.equal(await qwenDriver.probeReady(at("tok")), false, "an odd status answer");
  preheat = "succeeded";
  assert.equal(await qwenDriver.probeReady(at("tok")), true, "an unused workspace: started once, asleep now (what a restarted gateway finds)");
  channelAlive = true;
  seen.length = 0;
  assert.equal(await qwenDriver.probeReady(at("tok")), true);
  assert.deepEqual(seen, [{ url: "/health?deep=1", authorization: "Bearer tok" }], "a live agent process needs no second question");
  assert.equal(await qwenDriver.probeReady(at("wrong")), false, "a 401 is not ready");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await qwenDriver.probeReady(at("tok")), false, "connection refused");
});

test("request headers: the container token only for requests the browser authorised; Host is the container", () => {
  const endpoint = { host: "10.0.0.2", port: 4170, credential: "server-token" };
  const incoming = { host: "h:3107", authorization: "Bearer browser-token", cookie: "portal_session=x", origin: "http://h:3107", accept: "text/html" };
  assert.deepEqual(qwenDriver.requestHeaders(incoming, endpoint, { authorised: true }), {
    host: "10.0.0.2:4170",
    accept: "text/html",
    authorization: "Bearer server-token",
  });
  assert.deepEqual(qwenDriver.requestHeaders(incoming, endpoint, { authorised: false }), { host: "10.0.0.2:4170", accept: "text/html" });
});

test("person activity: changes count, reads and heartbeats don't", () => {
  assert.equal(qwenDriver.isUserAction("POST", "/session/abc/prompt"), true);
  assert.equal(qwenDriver.isUserAction("POST", "/session/abc/heartbeat"), false);
  assert.equal(qwenDriver.isUserAction("GET", "/session/abc"), false);
  assert.equal(qwenDriver.isUserAction("OPTIONS", "/x"), false);
});
