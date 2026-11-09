// End-to-end tests of the gateway without Docker: a fake ContainerRuntime launches in-process fake
// `qwen serve` servers, and a fake LLM server and a stub search backend stand in for the host
// services. The first part walks one gateway through a user's day; the lifecycle tests at the end
// each get a gateway of their own and drive time with the manager's injectable clock.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import WebSocket from "ws";
import { hashSessionToken, llmUsage, sessions, workspaces } from "@portal/db";
import { closeEndedSessions, PRESENCE_MS } from "../src/connections.ts";
import { userPaths } from "../src/paths.ts";
import { AGENT_UNKNOWN_GRACE_MS } from "../src/policy.ts";
import type { SettingsObject } from "../src/agents/qwen-settings.ts";
import { WorkspaceImageMissingError } from "../src/runtime.ts";
import { createServiceServer } from "../src/service-api.ts";
import { DeletingError, WorkspaceManager, type WorkspaceInfo } from "../src/workspaces.ts";
import { closeServer, listenLocal } from "./fakes.ts";
import {
  bearerSubprotocol,
  closed,
  cookie,
  json,
  MIN,
  request,
  startGateway,
  waitFor,
  type AgentSocket,
  type Gateway,
  type GatewayOptions,
  type Reply,
  type WsOutcome,
} from "./harness.ts";

let g: Gateway;
/** alice's second login (another browser). */
let aliceSecond = "";
let aliceSocket: WebSocket;
let adminSocket: WebSocket;

before(async () => {
  g = await startGateway({ readyAfterMs: 300 });
});

after(async () => {
  await g?.close();
});

function opened(outcome: WsOutcome): AgentSocket {
  assert.ok("socket" in outcome, `expected the socket to open, got ${JSON.stringify(outcome)}`);
  return outcome;
}

function errorCode(reply: Reply): string {
  return json<{ error: string }>(reply).error;
}

function pick<T extends object, K extends keyof T>(value: T, keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A WebSocket handshake whose refusal can be read (status, JSON body, headers), on the shared gateway. */
function upgrade(token: string | null, userId: number, protocols?: string[]): Promise<Reply> {
  const offered = protocols ?? ["qwen-ws", ...(token ? [bearerSubprotocol(g.browserToken(token, userId))] : [])];
  const headers: Record<string, string> = {
    origin: g.agentOrigin(userId),
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-protocol": offered.join(", "),
  };
  if (token) headers.cookie = cookie(token);
  return request(g.agentPort(userId), { path: "/terminal", headers });
}

// ------------------------------------------------------------------ signed out, stopped, origin, other users

test("signed-out navigations get the themed page; other requests get 401", async () => {
  const { alice } = g.ids;
  for (const token of [null, "not-a-session"]) {
    const page = await g.navigate(token, alice);
    assert.equal(page.status, 401);
    assert.match(page.headers["content-type"]!, /^text\/html/);
    assert.ok(page.body.includes("<h1>You&#39;re signed out</h1>"));
    assert.ok(page.body.includes(`href="//127.0.0.1:${g.config.webPort}/login" target="_top"`));
    assert.match(String(page.headers["content-security-policy"]), new RegExp(`frame-ancestors http://127\\.0\\.0\\.1:${g.config.webPort} https://127\\.0\\.0\\.1:${g.config.webPort}`));

    const api = await g.xhr(token, alice, { path: "/api/sessions", bearer: "anything" });
    assert.equal(api.status, 401);
    assert.deepEqual(json(api), { error: "unauthenticated", message: "You are signed out." });

    assert.deepEqual(await g.openSocket(token, alice), { status: 401 });
  }
});

test("XHR and WebSocket requests to a stopped workspace get 503 and never start it", async () => {
  const { alice } = g.ids;
  const api = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions" });
  assert.equal(api.status, 503);
  assert.equal(errorCode(api), "workspace_stopped");
  assert.equal((await g.xhr(g.tokens.alice, alice, { path: "/api/sessions", bearer: "wrong" })).status, 401, "a wrong token is refused first");
  assert.deepEqual(await g.openSocket(g.tokens.alice, alice), { status: 503 });
  const socket = await upgrade(g.tokens.alice, alice);
  assert.deepEqual([socket.status, json(socket)], [503, { error: "workspace_stopped", message: "The workspace is not running." }], "the same codes as HTTP");
  const badToken = await upgrade(g.tokens.alice, alice, ["qwen-ws", bearerSubprotocol("wrong")]);
  assert.deepEqual([badToken.status, json(badToken)], [401, { error: "invalid_token", message: "Reload the portal page to reconnect to your workspace." }]);
  const asset = await request(g.agentPort(alice), { path: "/assets/app.js", headers: { cookie: cookie(g.tokens.alice), accept: "*/*" } });
  assert.equal(asset.status, 503, "no Sec-Fetch-Mode and no text/html in Accept: not a navigation");
  assert.equal(g.info(alice).status, "stopped");
  assert.equal(g.runtime.starts.length, 0);
  assert.equal(g.workspaceRow(alice), undefined, "nothing was recorded");
});

test("a foreign Origin and cross-site writes are refused", async () => {
  const { alice, bob } = g.ids;
  for (const origin of ["http://evil.example", `http://127.0.0.1:${g.config.webPort}`, "null", g.agentOrigin(bob)]) {
    const reply = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions", headers: { origin } });
    assert.equal(reply.status, 403, origin);
    assert.equal(errorCode(reply), "forbidden_origin");
    assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { headers: { origin } }), { status: 403 }, origin);
  }
  const crossSite = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/echo", headers: { "sec-fetch-site": "cross-site" }, body: "x" });
  assert.equal(crossSite.status, 403);
  assert.equal(errorCode(crossSite), "forbidden_cross_site");
  assert.deepEqual(await g.openSocket(g.tokens.alice, alice, { headers: { "sec-fetch-site": "cross-site" } }), { status: 403 });
  assert.equal(g.info(alice).status, "stopped");
});

test("a port outside the workspace range serves no workspace", async () => {
  const stray = g.createAgentServer();
  const port = await listenLocal(stray);
  try {
    const reply = await request(port, { headers: { cookie: cookie(g.tokens.alice), "sec-fetch-mode": "navigate", accept: "text/html" } });
    assert.equal(reply.status, 404);
    assert.deepEqual(json(reply), { error: "not_found", message: "No workspace here." });
  } finally {
    await closeServer(stray);
  }
});

test("a session only gets into the workspace on its own user's port", async () => {
  const { alice, bob } = g.ids;
  const page = await g.navigate(g.tokens.bob, alice);
  assert.equal(page.status, 403);
  assert.ok(page.body.includes("<h1>This workspace isn&#39;t open here</h1>"));
  assert.ok(page.body.includes(`href="//127.0.0.1:${g.config.webPort}/" target="_top"`));

  const api = await g.xhr(g.tokens.bob, alice, { path: "/api/sessions" });
  assert.equal(api.status, 403);
  assert.equal(errorCode(api), "other_workspace");
  assert.deepEqual(await g.openSocket(g.tokens.bob, alice), { status: 403 }, "even with a token minted for alice's workspace");
  assert.equal((await g.xhr(g.tokens.admin, bob, { path: "/api/sessions" })).status, 403, "an admin who has not opened bob's workspace");
  assert.equal((await g.navigate(g.tokens.admin, bob)).status, 403);
  assert.equal(g.runtime.starts.length, 0, "nothing was started");
});

// ------------------------------------------------------------------ start and proxy

test("a page load from another site does not start a stopped workspace", async () => {
  const { alice } = g.ids;
  const page = await g.navigate(g.tokens.alice, alice, "/", { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" });
  assert.equal(page.status, 503);
  assert.ok(page.body.includes("Your workspace is stopped"));
  assert.ok(page.body.includes('action="/__portal/start"'));
  assert.equal(g.info(alice).status, "stopped", "nothing was started");
  assert.equal(g.runtime.runningUsers().length, 0);
});

test("a document navigation starts the workspace, shows the starting page, then proxies", async () => {
  const { alice } = g.ids;
  aliceSecond = g.addSession(alice);
  // Both of alice's browsers load the page at once.
  const pages = await Promise.all([g.navigate(g.tokens.alice, alice), g.navigate(aliceSecond, alice)]);
  for (const starting of pages) {
    assert.equal(starting.status, 503);
    assert.ok(starting.body.includes("Starting your workspace…"));
    assert.ok(starting.body.includes('<meta http-equiv="refresh" content="2">'));
    assert.ok(starting.body.includes('class="spinner"'));
    assert.equal(starting.headers["retry-after"], "2");
  }
  assert.equal(g.info(alice).status, "starting");

  const again = await g.navigate(g.tokens.alice, alice);
  assert.ok(again.body.includes("Starting your workspace…"), "a reload while starting shows the page again");
  const early = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions" });
  assert.equal(early.status, 503);
  assert.equal(errorCode(early), "workspace_starting");
  const earlySocket = await upgrade(g.tokens.alice, alice);
  assert.deepEqual([earlySocket.status, errorCode(earlySocket), earlySocket.headers["retry-after"]], [503, "workspace_starting", "2"]);

  await g.waitReady(alice);
  g.runtime.readyAfterMs = 0; // later starts need not show the starting page
  const starts = g.runtime.startsFor(alice);
  assert.equal(starts.length, 1, "two sessions, one container");
  assert.equal(g.workspaceRow(alice)?.status, "running");
  assert.equal(g.workspaceRow(alice)?.containerId, starts[0]!.containerId);
  assert.deepEqual(
    g.auditActions(alice).map((entry) => entry.action),
    ["workspace_started"],
  );
  const dirs = userPaths(g.dataDir, alice);
  const mode = (file: string): number => fs.statSync(file).mode & 0o777;
  assert.deepEqual([dirs.root, dirs.home, dirs.workspace, dirs.system, dirs.agentSettings("qwen")].map(mode), [0o711, 0o700, 0o700, 0o755, 0o755]);

  const page = await g.navigate(g.tokens.alice, alice);
  assert.equal(page.status, 200);
  assert.equal(page.body, "<!doctype html><title>Qwen Code</title>");
  assert.equal(page.headers["set-cookie"], undefined, "the browser never receives workspace cookies");
  assert.equal(page.headers["x-frame-options"], undefined);
  assert.equal(page.headers["content-security-policy"], `default-src 'self'; frame-ancestors http://127.0.0.1:${g.config.webPort} https://127.0.0.1:${g.config.webPort}`);

  const qwen = g.runtime.qwenFor(alice);
  const seen = qwen.requests.at(-1)!;
  assert.equal(seen.url, "/");
  assert.equal(seen.headers.host, `${qwen.host}:${qwen.port}`);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers.origin, undefined);
  assert.equal(seen.headers.authorization, undefined, "the static shell is fetched without a token");
  assert.equal(seen.headers["sec-fetch-mode"], undefined);

  const asset = await request(g.agentPort(alice), { path: "/assets/app.js", headers: { cookie: cookie(g.tokens.alice), accept: "*/*" } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
});

test("every session of a user uses the same container, each with its own browser token", async () => {
  const { alice } = g.ids;
  const qwen = g.runtime.qwenFor(alice);
  const containerId = g.workspaceRow(alice)?.containerId;
  for (const token of [g.tokens.alice, aliceSecond]) {
    const reply = await g.xhr(token, alice, { path: "/api/sessions" });
    assert.equal(reply.status, 200);
    assert.equal(qwen.requests.at(-1)!.headers.authorization, `Bearer ${qwen.token}`);
  }
  assert.notEqual(g.browserToken(g.tokens.alice, alice), g.browserToken(aliceSecond, alice));
  const swapped = await g.xhr(aliceSecond, alice, { path: "/api/sessions", bearer: g.browserToken(g.tokens.alice, alice) });
  assert.equal(swapped.status, 401, "a browser token only works with the session it was made for");

  const again = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${alice}/start`));
  assert.equal(again.status, "running");
  assert.equal(g.runtime.startsFor(alice).length, 1, "still one startWorkspace call");
  assert.equal(g.workspaceRow(alice)?.containerId, containerId);
});

test("the browser's token is swapped for the container's; cookies and Origin stay at the gateway", async () => {
  const { alice, bob } = g.ids;
  const qwen = g.runtime.qwenFor(alice);
  const browser = g.browserToken(g.tokens.alice, alice);

  // No token: forwarded as it is, and the workspace refuses it itself.
  let before = qwen.requests.length;
  const anonymous = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions", bearer: null });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(json(anonymous), { error: "Unauthorized" });
  assert.equal(qwen.requests.length, before + 1);
  assert.equal(qwen.requests.at(-1)!.headers.authorization, undefined);

  // Wrong tokens never reach the workspace.
  before = qwen.requests.length;
  const wrong = [
    "Bearer wrong",
    `Bearer ${qwen.token}`, // the container's real token is not a browser token
    `Bearer ${g.browserToken(g.tokens.alice, bob)}`, // alice's token for another workspace
    `Bearer ${g.browserToken(g.tokens.bob, alice)}`, // made from another user's session
    `Basic ${Buffer.from(`user:${browser}`).toString("base64")}`,
    `Bearer ${browser}x`,
    "Bearer",
  ];
  for (const authorization of wrong) {
    const reply = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions", bearer: null, headers: { authorization } });
    assert.equal(reply.status, 401, authorization);
    assert.deepEqual(json(reply), { error: "invalid_token", message: "Reload the portal page to reconnect to your workspace." });
  }
  assert.equal(qwen.requests.length, before, "refused by the gateway");

  // The right token: the container's own token goes upstream, and nothing else of the browser's.
  const echo = await g.xhr(g.tokens.alice, alice, {
    method: "POST",
    path: "/api/echo",
    headers: { "content-type": "text/plain", "x-forwarded-for": "6.6.6.6", forwarded: "for=6.6.6.6" },
    body: "ping",
  });
  assert.equal(echo.status, 200);
  assert.equal(echo.body, "ping");
  const seen = qwen.requests.at(-1)!;
  assert.equal(seen.headers.authorization, `Bearer ${qwen.token}`);
  assert.equal(seen.headers.host, `${qwen.host}:${qwen.port}`);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers.origin, undefined, "the browser sent one; the gateway checked it and dropped it");
  assert.equal(seen.headers["x-forwarded-for"], undefined);
  assert.equal(seen.headers.forwarded, undefined);
  const forwarded = JSON.stringify(seen.headers);
  assert.equal(forwarded.includes(g.tokens.alice), false, "the portal session never reaches the workspace");
  assert.equal(forwarded.includes(browser), false);

  const api = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions" });
  assert.equal(api.status, 200);
  assert.equal(api.headers["set-cookie"], undefined);
  assert.equal(api.headers["cache-control"], "private, no-store");
});

test("device pairing is not available through the portal", async () => {
  const { alice } = g.ids;
  const qwen = g.runtime.qwenFor(alice);
  const before = qwen.requests.length;
  const spellings = [
    "/web-shell/pairing", "/web-shell/pairing/", "/web-shell/pairing?code=1", "/web-shell/pairing/approve",
    // Dot segments, case, doubled slashes, backslashes and percent-encoding must not slip past the block.
    "/web-shell/./pairing", "/x/../web-shell/pairing", "/Web-Shell/Pairing", "//web-shell/pairing",
    "/web-shell//pairing", "/web-shell/%70airing", "/web-shell%2Fpairing", "/web-shell/%2e/pairing",
    "/web-shell/%252e/pairing", "/web-shell\\pairing",
  ];
  for (const target of spellings) {
    for (const method of ["GET", "POST"]) {
      const reply = await g.xhr(g.tokens.alice, alice, { method, path: target });
      assert.equal(reply.status, 403, `${method} ${target}`);
      assert.equal(errorCode(reply), "not_available");
      assert.equal(reply.body.includes(qwen.token), false);
    }
  }
  assert.equal(qwen.requests.length, before, "none reached the workspace");
});

test("event streams and recent requests count as open tabs, not as activity; heartbeats are not activity; writes are", async () => {
  const { alice } = g.ids;
  g.clock.now += MIN;
  assert.deepEqual(g.info(alice).connections, { owner: 0, admin: 0 }, "earlier requests no longer count as presence");
  const before = g.info(alice).lastActivityAt;
  const stream = await new Promise<{ first: string; req: http.ClientRequest }>((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: g.agentPort(alice),
        path: "/session/s1/events",
        headers: { cookie: cookie(g.tokens.alice), accept: "text/event-stream", authorization: `Bearer ${g.browserToken(g.tokens.alice, alice)}` },
        agent: false,
      },
      (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream");
        res.once("data", (chunk: Buffer) => resolve({ first: chunk.toString("utf8"), req }));
      },
    );
    req.on("error", (error) => (error.message === "socket hang up" ? undefined : reject(error)));
  });
  assert.equal(stream.first, "event: ready\ndata: 1\n\n", "the first event arrives while the stream stays open");
  assert.deepEqual(g.info(alice).connections, { owner: 1, admin: 0 }, "the stream and the request that opened it are one session");
  assert.equal(g.info(alice).lastActivityAt, before, "GET is not activity");

  const heartbeat = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/session/s1/heartbeat" });
  assert.equal(heartbeat.status, 204);
  assert.equal(g.info(alice).lastActivityAt, before, "heartbeats are not activity");

  stream.req.destroy();
  g.clock.now += PRESENCE_MS + 1;
  await waitFor(() => g.info(alice).connections.owner === 0, "the closed stream to be unregistered and the presence to expire");

  // A tab on the Web Shell's home page keeps no stream open, but it polls: that counts too.
  assert.equal((await g.xhr(g.tokens.alice, alice, { path: "/api/sessions" })).status, 200);
  assert.deepEqual(g.info(alice).connections, { owner: 1, admin: 0 });

  const write = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/echo", body: "x" });
  assert.equal(write.status, 200);
  assert.equal(g.info(alice).lastActivityAt, g.clock.now, "a write is someone using the workspace");
});

test("uploads are streamed and limited", async () => {
  const { alice } = g.ids;
  const qwen = g.runtime.qwenFor(alice);
  const authorization = `Bearer ${g.browserToken(g.tokens.alice, alice)}`;

  const fits = await g.xhr(g.tokens.alice, alice, { method: "POST", path: "/api/upload", body: Buffer.alloc(512 * 1024, 1) });
  assert.equal(fits.status, 200);
  assert.deepEqual(json(fits), { bytes: 512 * 1024 });

  const uploadsBefore = qwen.uploads.length;
  const declared = await g
    .xhr(g.tokens.alice, alice, { method: "POST", path: "/api/upload", headers: { "content-length": String(2 * 1024 * 1024) } })
    .catch((error: Error) => ({ status: -1, headers: {}, body: error.message }));
  assert.equal(declared.status, 413, "rejected from Content-Length before anything is forwarded");
  assert.equal(qwen.uploads.length, uploadsBefore);

  // A chunked body with no Content-Length is cut off once it passes the limit.
  const streamed = await new Promise<number>((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: g.agentPort(alice),
        method: "POST",
        path: "/api/upload",
        headers: { cookie: cookie(g.tokens.alice), origin: g.agentOrigin(alice), authorization, "transfer-encoding": "chunked" },
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", () => resolve(-1));
    const chunk = Buffer.alloc(128 * 1024, 2);
    let sent = 0;
    const pump = (): void => {
      while (sent < 16 && req.write(chunk)) sent++;
      if (sent < 16) req.once("drain", pump);
      else req.end();
    };
    pump();
  });
  assert.ok(streamed === 413 || streamed === -1, `413 or a reset connection, got ${streamed}`);
  await waitFor(() => qwen.uploads.length === uploadsBefore + 1, "the streamed upload to reach the workspace");
  const cut = qwen.uploads.at(-1)!;
  assert.equal(cut.complete, false, "the workspace never sees the whole oversized body");
  assert.ok(cut.bytes <= 1024 * 1024 + 128 * 1024);
});

// ------------------------------------------------------------------ WebSocket relay

test("WebSocket /terminal: the token travels as a subprotocol and is swapped; the workspace's protocol is echoed", async () => {
  const { alice } = g.ids;
  const qwen = g.runtime.qwenFor(alice);
  const { socket, next } = opened(await g.openSocket(g.tokens.alice, alice));
  aliceSocket = socket;
  assert.equal(socket.protocol, "qwen-ws");
  const greeting = await next();
  assert.equal(greeting.data.toString(), "hello from qwen /terminal", "messages sent before the browser is attached arrive");
  assert.equal(greeting.binary, false);

  const handshake = qwen.sockets.at(-1)!;
  assert.equal(handshake.headers.authorization, `Bearer ${qwen.token}`);
  assert.equal(handshake.headers["sec-websocket-protocol"], "qwen-ws", "the browser's token is not offered upstream");
  assert.equal(handshake.headers.host, `${qwen.host}:${qwen.port}`);
  assert.equal(handshake.headers.cookie, undefined);
  assert.equal(handshake.headers.origin, undefined);

  g.clock.now += MIN;
  const before = g.info(alice).lastActivityAt;
  await new Promise((resolve) => setTimeout(resolve, 200)); // several workspace pings pass through the gateway
  assert.equal(g.info(alice).lastActivityAt, before, "workspace messages and pings are not activity");

  socket.send("from the browser");
  assert.deepEqual(await next(), { data: Buffer.from("from the browser"), binary: false });
  assert.equal(g.info(alice).lastActivityAt, g.clock.now, "typing in the terminal is activity");

  socket.send(Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(await next(), { data: Buffer.from([0, 1, 2, 255]), binary: true });
  assert.deepEqual(g.info(alice).connections, { owner: 1, admin: 0 });
});

test("WebSocket upgrades need this session's token for this workspace, and a Web Shell path", async () => {
  const { alice, bob } = g.ids;
  const token = g.tokens.alice;
  const qwen = g.runtime.qwenFor(alice);
  const accepted = qwen.sockets.length;
  const refused = [
    ["qwen-ws"],
    ["qwen-ws", bearerSubprotocol("wrong")],
    ["qwen-ws", "qwen-bearer.!!not-base64!!"],
    ["qwen-ws", bearerSubprotocol(qwen.token)],
    ["qwen-ws", bearerSubprotocol(g.browserToken(token, bob))],
    ["qwen-ws", bearerSubprotocol(g.browserToken(aliceSecond, alice))],
  ];
  for (const protocols of refused) {
    assert.deepEqual(await g.openSocket(token, alice, { protocols }), { status: 401 }, protocols.join(", "));
  }
  assert.equal(qwen.sockets.length, accepted, "none reached the workspace");

  for (const target of ["/acp", "/live/web?session=1"]) {
    const { socket, next } = opened(await g.openSocket(token, alice, { path: target }));
    assert.equal((await next()).data.toString(), `hello from qwen ${target.split("?")[0]}`);
    socket.close();
    await closed(socket);
  }
  // Clients that can set headers may send the token as Authorization instead.
  const viaHeader = opened(
    await g.openSocket(token, alice, { protocols: ["qwen-ws"], headers: { authorization: `Bearer ${g.browserToken(token, alice)}` } }),
  );
  assert.equal(qwen.sockets.at(-1)!.headers.authorization, `Bearer ${qwen.token}`);
  viaHeader.socket.close();
  await closed(viaHeader.socket);
  assert.deepEqual(g.info(alice).connections, { owner: 1, admin: 0 }, "one session, however many sockets");

  const other = await request(g.agentPort(alice), {
    path: "/api/other.socket",
    headers: {
      cookie: cookie(token),
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-protocol": bearerSubprotocol(g.browserToken(token, alice)),
    },
  });
  assert.equal(other.status, 404, "only the Web Shell's sockets can be opened");
});

test("an admin reaches another user's workspace only while acting as them", async () => {
  const { alice, bob, admin } = g.ids;
  const token = g.tokens.admin;
  assert.equal((await g.xhr(token, alice, { path: "/api/sessions" })).status, 403, "not before opening it");

  g.actAs(token, alice);
  const qwen = g.runtime.qwenFor(alice);
  const api = await g.xhr(token, alice, { path: "/api/sessions" });
  assert.equal(api.status, 200);
  assert.equal(qwen.requests.at(-1)!.headers.authorization, `Bearer ${qwen.token}`);
  assert.equal((await g.xhr(token, admin, { path: "/api/sessions" })).status, 403, "the admin's own workspace is not the open one");
  assert.equal((await g.xhr(token, bob, { path: "/api/sessions" })).status, 403);
  assert.equal((await g.xhr(token, alice, { path: "/api/sessions", bearer: g.browserToken(g.tokens.alice, alice) })).status, 401, "alice's token is hers");

  const viewer = opened(await g.openSocket(token, alice));
  adminSocket = viewer.socket;
  assert.equal((await viewer.next()).data.toString(), "hello from qwen /terminal");
  assert.deepEqual(g.info(alice).connections, { owner: 1, admin: 1 });
});

// ------------------------------------------------------------------ control API

test("the control API requires the bearer token", async () => {
  assert.equal((await g.control("GET", "/control/health", undefined, "wrong-secret")).status, 401);
  const missing = await request(g.ports.control, { path: "/control/health" });
  assert.equal(missing.status, 401);
  assert.deepEqual(json(missing), { error: "unauthorized", message: "Missing or wrong control token." });
});

test("control API: health, stats, workspaces, errors", async () => {
  const { alice, dave } = g.ids;
  assert.deepEqual(json(await g.control("GET", "/control/health")), { ok: true });

  const stats = json<Record<string, unknown>>(await g.control("GET", "/control/stats"));
  assert.equal(stats.running, 1);
  assert.equal(stats.maxRunning, 2);
  assert.equal(stats.idleTimeoutMinutes, 30);
  assert.ok((stats.memTotalBytes as number) > 0 && (stats.memAvailableBytes as number) > 0);
  assert.equal((stats.loadAvg as number[]).length, 3);
  assert.ok((stats.cpus as number) >= 1);
  assert.deepEqual(stats.llm, { inFlight: 0, queued: 0, maxConcurrency: 2 });

  await g.manager.refreshSamples();
  const info = json<WorkspaceInfo>(await g.control("GET", `/control/workspaces/${alice}`));
  assert.equal(info.status, "running");
  assert.equal(info.ready, true);
  assert.equal(info.memoryBytes, g.runtime.memoryBytes);
  assert.deepEqual(info.connections, { owner: 1, admin: 1 });
  assert.equal(info.llmInFlight, 0);
  assert.equal(typeof info.idleSeconds, "number");
  assert.deepEqual(pick(info, ["busy", "busyReason", "stopPending"]), { busy: false, busyReason: null, stopPending: false });
  assert.equal(info.agent, "qwen");
  assert.deepEqual(Object.keys(info).sort(), [
    "agent",
    "busy",
    "busyReason",
    "connections",
    "idleSeconds",
    "lastActivityAt",
    "lastError",
    "llmInFlight",
    "memoryBytes",
    "ready",
    "startedAt",
    "status",
    "stopPending",
    "stopReason",
    "userId",
  ]);

  const list = json<{ workspaces: WorkspaceInfo[] }>(await g.control("GET", "/control/workspaces"));
  assert.deepEqual(list.workspaces.map((w) => w.userId), [alice], "only users with a row");

  const never = json<WorkspaceInfo>(await g.control("GET", `/control/workspaces/${dave}`));
  assert.equal(never.status, "stopped");
  assert.equal(never.idleSeconds, null);
  assert.equal(never.memoryBytes, null);
  assert.equal(never.busy, false);

  assert.equal((await g.control("GET", "/control/workspaces/abc")).status, 400);
  assert.equal((await g.control("GET", "/control/nope")).status, 404);
  const wrongMethod = await g.control("POST", "/control/health");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  const unknownUser = await g.control("POST", "/control/workspaces/9999/start");
  assert.equal(unknownUser.status, 404);
  assert.equal(errorCode(unknownUser), "user_not_found");
  for (const reason of [42, "logout", "idle", "Admin", " admin", ""]) {
    const reply = await g.control("POST", `/control/workspaces/${dave}/stop`, { reason });
    assert.deepEqual([reply.status, errorCode(reply)], [400, "invalid_reason"], JSON.stringify(reason));
  }
  assert.equal((await g.control("POST", `/control/workspaces/${dave}/stop`, { actorUserId: 9999 })).status, 400);
  const badJson = await request(g.ports.control, {
    method: "POST",
    path: `/control/workspaces/${dave}/stop`,
    headers: { authorization: `Bearer ${g.config.controlSecret}`, "content-type": "application/json" },
    body: "{",
  });
  assert.equal(badJson.status, 400);
  assert.equal(errorCode(badJson), "invalid_json");
});

test("disconnect closes only that session's sockets", async () => {
  const { alice } = g.ids;
  const adminClosed = closed(adminSocket);
  const reply = json<{ closed: number }>(await g.control("POST", `/control/sessions/${hashSessionToken(g.tokens.admin)}/disconnect`));
  assert.deepEqual(reply, { closed: 1 });
  assert.equal(await adminClosed, 4001);
  assert.equal(aliceSocket.readyState, WebSocket.OPEN);
  await waitFor(() => g.info(alice).connections.admin === 0, "admin connection to be gone");
  assert.deepEqual(g.info(alice).connections, { owner: 1, admin: 0 });
  assert.deepEqual(json(await g.control("POST", "/control/sessions/unknown/disconnect")), { closed: 0 });
});

test("release stops the workspace only once no session uses it", async () => {
  const { alice } = g.ids;
  const release = async (): Promise<WorkspaceInfo> => json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${alice}/release`));
  assert.equal((await release()).status, "running", "alice's sessions and the admin viewing her still use it");

  g.db.delete(sessions).where(eq(sessions.id, hashSessionToken(aliceSecond))).run();
  assert.equal((await release()).status, "running", "signing out one browser leaves the other");

  g.db.delete(sessions).where(eq(sessions.userId, alice)).run();
  assert.equal((await release()).status, "running", "the admin is still viewing alice's workspace");

  const ownerClosed = closed(aliceSocket);
  g.actAs(g.tokens.admin, null);
  assert.equal((await g.xhr(g.tokens.admin, alice, { path: "/api/sessions" })).status, 403, "the admin has left alice's workspace");
  const released = await release();
  assert.equal(released.status, "stopped");
  assert.equal(released.stopReason, "logout");
  assert.equal(released.stopPending, false);
  assert.equal(await ownerClosed, 1001, "open agent sockets are closed when the workspace stops");
  assert.deepEqual(g.runtime.runningUsers(), []);
  assert.equal(g.workspaceRow(alice)?.status, "stopped");
  assert.deepEqual(g.auditActions(alice).at(-1), { action: "workspace_stopped", details: { reason: "logout" }, actorUserId: null });

  // The cached session must not let the signed-out browser restart the workspace.
  const page = await g.navigate(g.tokens.alice, alice);
  assert.equal(page.status, 401);
  g.tokens.alice = g.addSession(alice);
});

test("stop records the acting admin in the audit log", async () => {
  const { dave, admin } = g.ids;
  json(await g.control("POST", `/control/workspaces/${dave}/start`));
  await g.waitReady(dave);
  const stopped = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${dave}/stop`, { reason: "deactivated", actorUserId: admin }));
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.stopReason, "deactivated");
  assert.deepEqual(g.auditActions(dave).at(-1), { action: "workspace_stopped", details: { reason: "deactivated" }, actorUserId: admin });
  const again = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${dave}/stop`));
  assert.equal(again.stopReason, "deactivated", "stopping a stopped workspace changes nothing");
});

// ------------------------------------------------------------------ capacity and reaper

test("start returns while Qwen Code boots; capacity 409 and eviction of an idle workspace", async () => {
  const { alice, bob, carol } = g.ids;
  const started = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${alice}/start`));
  assert.equal(started.status, "starting");
  assert.equal(started.ready, false);
  json(await g.control("POST", `/control/workspaces/${bob}/start`));
  await Promise.all([g.waitReady(alice), g.waitReady(bob)]);

  const full = await g.control("POST", `/control/workspaces/${carol}/start`);
  assert.equal(full.status, 409);
  assert.equal(errorCode(full), "capacity");
  const page = await g.navigate(g.tokens.carol, carol);
  assert.equal(page.status, 503);
  assert.ok(page.body.includes("All 2 workspace slots are in use"));
  assert.ok(page.body.includes('action="/__portal/start"'));
  assert.equal(g.info(carol).status, "stopped");

  g.clock.now += 6 * MIN;
  g.manager.touch(bob);
  const evicting = json<WorkspaceInfo>(await g.control("POST", `/control/workspaces/${carol}/start`));
  assert.equal(evicting.status, "starting");
  assert.equal(g.info(alice).status, "stopped");
  assert.equal(g.info(alice).stopReason, "capacity", "the longest-idle workspace made room");
  assert.equal(g.info(bob).status, "running");
  await g.waitReady(carol);
  assert.deepEqual(g.runtime.runningUsers(), [bob, carol].sort((a, b) => a - b));
});

test("the idle reaper stops idle workspaces but not one whose CPU is busy", async () => {
  const { bob, carol } = g.ids;
  g.runtime.cpuSeconds.set(bob, 100);
  g.runtime.cpuSeconds.set(carol, 100);
  await g.manager.refreshSamples(); // the first sample of each

  g.clock.now += 31 * MIN;
  g.runtime.cpuSeconds.set(bob, 100 + 31 * 60 * 0.5);
  await g.manager.refreshSamples();
  assert.equal(g.info(bob).busyReason, "cpu");
  await g.manager.reap();
  assert.equal(g.info(carol).status, "stopped");
  assert.equal(g.info(carol).stopReason, "idle");
  assert.equal(g.info(bob).status, "running", "busy CPU counts as activity");
  assert.equal(g.info(bob).lastActivityAt, g.clock.now);

  // The build is over: the next sample (15 s later) sees it, and the countdown starts.
  g.clock.now += 15_000;
  g.runtime.cpuSeconds.set(bob, 100 + 31 * 60 * 0.5 + 0.15);
  await g.manager.refreshSamples();
  assert.equal(g.info(bob).busy, false);
  g.clock.now += 31 * MIN;
  g.runtime.cpuSeconds.set(bob, 100 + 31 * 60 * 0.5 + 10);
  await g.manager.refreshSamples();
  await g.manager.reap();
  assert.equal(g.info(bob).stopReason, "idle");
  assert.deepEqual(g.runtime.runningUsers(), []);
});

test("the reaper stops workspaces whose sessions are all gone", async () => {
  const { carol } = g.ids;
  json(await g.control("POST", `/control/workspaces/${carol}/start`));
  await g.waitReady(carol);
  await g.manager.reap();
  assert.equal(g.info(carol).status, "running");
  g.db.delete(sessions).where(eq(sessions.userId, carol)).run();
  await g.manager.reap();
  assert.equal(g.info(carol).status, "stopped");
  assert.equal(g.info(carol).stopReason, "logout");
  g.tokens.carol = g.addSession(carol);
});

// ------------------------------------------------------------------ service API

test("the LLM proxy streams, swaps the key and records usage", async () => {
  const { alice } = g.ids;
  json(await g.control("POST", `/control/workspaces/${alice}/start`));
  await g.waitReady(alice);
  g.caller.userId = alice;
  g.clock.now += MIN;
  const llmHeaders = { authorization: "Bearer portal", "content-type": "application/json", "accept-encoding": "gzip" };

  const models = await request(g.ports.service, { path: "/llm/v1/models", headers: llmHeaders });
  assert.equal(models.status, 200);
  assert.deepEqual(json(models), { data: [{ id: "qwen3.8-flash-next" }] });
  const forwarded = g.llm.requests.at(-1)!;
  assert.equal(forwarded.headers.authorization, "Bearer test-llm-key");
  assert.equal(forwarded.headers["accept-encoding"], "identity");

  // The first SSE chunk reaches the workspace while the LLM is still generating.
  const timeline: Array<{ at: number; text: string }> = [];
  const start = Date.now();
  const streamed = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: g.ports.service, method: "POST", path: "/llm/v1/chat/completions?trace=1", headers: llmHeaders, agent: false },
      (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream");
        res.on("data", (chunk: Buffer) => timeline.push({ at: Date.now() - start, text: chunk.toString("utf8") }));
        res.on("end", () => resolve(timeline.map((entry) => entry.text).join("")));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "m", stream: true, messages: [] }));
  });
  assert.equal(g.llm.requests.at(-1)!.url, "/v1/chat/completions?trace=1");
  assert.ok(streamed.endsWith("data: [DONE]\n\n"));
  assert.ok(timeline.length >= 2 && timeline.at(-1)!.at - timeline[0]!.at >= 100, "chunks are not buffered");

  const plain = await request(g.ports.service, {
    method: "POST",
    path: "/llm/v1/chat/completions",
    headers: llmHeaders,
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(plain.status, 200);
  assert.equal(json<{ usage: { prompt_tokens: number } }>(plain).usage.prompt_tokens, 11);

  const row = g.db.select().from(llmUsage).where(eq(llmUsage.userId, alice)).get();
  assert.deepEqual(row && { requests: row.requests, promptTokens: row.promptTokens, completionTokens: row.completionTokens }, {
    requests: 2,
    promptTokens: 12 + 11,
    completionTokens: 34 + 22,
  });
  assert.equal(g.info(alice).lastActivityAt, g.clock.now, "LLM requests are activity");
});

test("a workspace that hangs up frees its LLM slot and the upstream request", async () => {
  const { alice } = g.ids;
  const abandonedBefore = g.llm.abandoned;
  const req = http.request({
    host: "127.0.0.1",
    port: g.ports.service,
    method: "POST",
    path: "/llm/v1/chat/completions",
    headers: { "content-type": "application/json" },
    agent: false,
  });
  req.on("error", () => undefined);
  const firstChunk = new Promise<void>((resolve) => req.on("response", (res) => res.once("data", () => resolve())));
  req.end(JSON.stringify({ stream: true, hold: true }));
  await firstChunk;
  assert.equal(g.llmQueue.inFlight, 1);
  assert.equal(g.info(alice).llmInFlight, 1);
  assert.deepEqual(pick(g.info(alice), ["busy", "busyReason", "idleSeconds"]), { busy: true, busyReason: "llm", idleSeconds: 0 }, "waiting on the LLM is work");

  // Per-user limit is 1: a second request from alice queues behind the first.
  const queued = http.request({ host: "127.0.0.1", port: g.ports.service, method: "POST", path: "/llm/v1/chat/completions", agent: false });
  queued.on("error", () => undefined);
  queued.end(JSON.stringify({ stream: false }));
  await waitFor(() => g.llmQueue.queued === 1, "the second request to queue");
  queued.destroy();
  await waitFor(() => g.llmQueue.queued === 0, "the queued request to leave the queue");

  req.destroy();
  await waitFor(() => g.llmQueue.inFlight === 0, "the slot to be released");
  await waitFor(() => g.llm.abandoned === abandonedBefore + 1, "the upstream request to be aborted");
  assert.equal(g.info(alice).busy, false);
});

test("the service API refuses unknown callers and odd paths", async () => {
  g.caller.userId = null;
  const refused = await request(g.ports.service, { path: "/llm/v1/models" });
  assert.equal(refused.status, 403);
  assert.deepEqual(json(refused), { error: "forbidden", message: "Unknown caller." });

  g.caller.userId = g.ids.alice;
  assert.equal((await request(g.ports.service, { path: "/llm/v1/../../props" })).status, 400);
  assert.equal((await request(g.ports.service, { path: "/llm/v1/%2e%2e/props" })).status, 400);
  assert.equal((await request(g.ports.service, { path: "/admin" })).status, 404);
  assert.equal((await request(g.ports.service, { path: "/mcp/search/../../llm/v1/models" })).status, 404);
});

test("the LLM proxy only offers generation, embeddings and the model list", async () => {
  g.caller.userId = g.ids.alice;
  const forwarded = g.llm.requests.length;
  const notOffered = [
    ["GET", "/llm/v1/files"],
    ["POST", "/llm/v1/files"],
    ["DELETE", "/llm/v1/files/file-1"],
    ["POST", "/llm/v1/batches"],
    ["POST", "/llm/v1/fine_tuning/jobs"],
    ["POST", "/llm/v1/responses"],
    ["GET", "/llm/v1/"],
    ["POST", "/llm/v1/chat/completions/"],
    ["GET", "/llm/v1/models/"],
  ] as const;
  for (const [method, path] of notOffered) {
    const reply = await request(g.ports.service, { method, path });
    assert.equal(reply.status, 404, `${method} ${path}`);
    assert.deepEqual(json(reply), { error: { message: `${path} is not available to workspaces.`, type: "not_found" } });
  }
  const wrongMethod = [
    ["GET", "/llm/v1/chat/completions", "POST"],
    ["PUT", "/llm/v1/embeddings", "POST"],
    ["POST", "/llm/v1/models", "GET"],
    ["DELETE", "/llm/v1/models/qwen3.8-flash-next", "GET"],
  ] as const;
  for (const [method, path, allow] of wrongMethod) {
    const reply = await request(g.ports.service, { method, path });
    assert.equal(reply.status, 405, `${method} ${path}`);
    assert.equal(reply.headers.allow, allow);
    assert.deepEqual(json(reply), { error: { message: `Use ${allow} for ${path}.`, type: "method_not_allowed" } });
  }
  assert.equal(g.llm.requests.length, forwarded, "none of them reached the LLM server");

  const offered = [
    ["GET", "/llm/v1/models/qwen3.8-flash-next"],
    ["GET", "/llm/v1/models/Qwen/Qwen3-8B"],
    ["POST", "/llm/v1/completions"],
    ["POST", "/llm/v1/embeddings"],
  ] as const;
  for (const [method, path] of offered) {
    const body = method === "POST" ? "{}" : undefined;
    const reply = await request(g.ports.service, { method, path, headers: { "content-type": "application/json" }, body });
    assert.equal(reply.status, 200, `${method} ${path}`);
    assert.equal(g.llm.requests.at(-1)!.url, path.slice("/llm".length));
  }
  g.caller.userId = null;
});

test("agent and service servers wait at most a minute for request headers, and never time out a request", () => {
  const service = createServiceServer({ config: g.config, db: g.db, manager: g.manager, llm: g.llmQueue, log: g.log, search: g.searches as never });
  for (const server of [g.createAgentServer(), service]) {
    assert.equal(server.headersTimeout, 60_000, "a client that never finishes its headers is dropped (slowloris)");
    assert.equal(server.requestTimeout, 0, "uploads, event streams and generations take as long as they take");
  }
});

function mcp(body: unknown): Promise<Reply> {
  return request(g.ports.service, {
    method: "POST",
    path: "/mcp/search",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

test("the service API answers the search MCP itself, from the search backend", async () => {
  const { alice } = g.ids;
  g.caller.userId = alice;
  g.clock.now += MIN;
  const before = g.info(alice).lastActivityAt;

  const init = json<{ result: { serverInfo: { name: string } } }>(await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
  assert.equal(init.result.serverInfo.name, "workspace-portal-search");
  const list = json<{ result: { tools: Array<{ name: string }> } }>(await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["web_search"]);
  assert.equal(g.info(alice).lastActivityAt, before, "only searches count as the agent working");

  const call = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { query: " qwen code ", page: 2 } } });
  assert.equal(call.status, 200);
  assert.deepEqual(json(call), { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "results for qwen code" }] } });
  assert.deepEqual(g.searches.at(-1), { query: "qwen code", page: 2, timeRange: null, language: null });
  assert.equal(g.info(alice).lastActivityAt, g.clock.now, "a search is activity");

  g.caller.userId = null;
  const searches = g.searches.length;
  const refused = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } });
  assert.equal(refused.status, 403);
  assert.equal(g.searches.length, searches, "unknown callers can't search");
});

// ------------------------------------------------------------------ failures and recovery

test("a crashed container is noticed when the proxy can't reach it, and the next navigation restarts it", async () => {
  const { alice } = g.ids;
  const startsBefore = g.runtime.startsFor(alice).length;
  await g.runtime.crash(alice, 137);
  const page = await g.navigate(g.tokens.alice, alice);
  assert.equal(page.status, 502);
  assert.ok(page.body.includes("Your workspace isn&#39;t answering"));
  await waitFor(() => g.info(alice).status === "stopped", "the gateway to notice the exit");
  const crashed = g.info(alice);
  assert.equal(crashed.stopReason, "error");
  assert.match(crashed.lastError!, /^the workspace container exited unexpectedly \(exit code 137\)\nfake qwen: last log line$/);
  assert.equal(g.auditActions(alice).at(-1)?.action, "workspace_error");

  assert.ok((await g.navigate(g.tokens.alice, alice)).body.includes("Starting your workspace…"));
  await g.waitReady(alice);
  const starts = g.runtime.startsFor(alice);
  assert.equal(starts.length, startsBefore + 1);
  assert.notEqual(starts.at(-2)!.options.credential, starts.at(-1)!.options.credential, "every start gets a fresh token");
});

test("the stats refresh notices a crash without any request", async () => {
  const { alice } = g.ids;
  await g.runtime.crash(alice, 1);
  await g.manager.refreshSamples();
  assert.equal(g.info(alice).status, "stopped");
  assert.match(g.info(alice).lastError!, /^the workspace container exited unexpectedly \(exit code 1\)/);
  const api = await g.xhr(g.tokens.alice, alice, { path: "/api/sessions" });
  assert.equal(api.status, 503);
  assert.equal(errorCode(api), "workspace_stopped");
});

test("a failed start shows the error page, and Try again starts it", async () => {
  const { alice } = g.ids;
  g.runtime.failNextStart = new WorkspaceImageMissingError(g.config.workspace.images.qwen.image);
  await g.navigate(g.tokens.alice, alice);
  await waitFor(() => g.info(alice).status === "error", "the start to fail");
  assert.equal(g.info(alice).lastError, `workspace image ${g.config.workspace.images.qwen.image} not found`);
  assert.deepEqual(g.auditActions(alice).at(-1)?.details, { error: `workspace image ${g.config.workspace.images.qwen.image} not found` });

  const page = await g.navigate(g.tokens.alice, alice);
  assert.equal(page.status, 503);
  assert.ok(page.body.includes("<h1>Your workspace couldn&#39;t start</h1>"));
  assert.ok(page.body.includes(`<pre>workspace image ${g.config.workspace.images.qwen.image} not found</pre>`));
  assert.equal(g.info(alice).status, "error", "the error page does not retry by itself");
  const socket = await upgrade(g.tokens.alice, alice);
  assert.deepEqual([socket.status, errorCode(socket)], [503, "workspace_error"]);

  const crossSite = await request(g.agentPort(alice), {
    method: "POST",
    path: "/__portal/start",
    headers: { cookie: cookie(g.tokens.alice), origin: "http://evil.example" },
  });
  assert.equal(crossSite.status, 403);
  const otherUser = await request(g.agentPort(alice), {
    method: "POST",
    path: "/__portal/start",
    headers: { cookie: cookie(g.tokens.bob), origin: g.agentOrigin(alice), "sec-fetch-site": "same-origin" },
  });
  assert.equal(otherUser.status, 403, "nobody else can start alice's workspace from her port");
  assert.equal(g.info(alice).status, "error");

  const retry = await request(g.agentPort(alice), {
    method: "POST",
    path: "/__portal/start",
    headers: { cookie: cookie(g.tokens.alice), origin: g.agentOrigin(alice), "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(retry.status, 303);
  assert.equal(retry.headers.location, "/");
  await g.waitReady(alice);
});

test("deleting a user's data stops the workspace and removes its directories", async () => {
  const { alice } = g.ids;
  const root = userPaths(g.dataDir, alice).root;
  assert.ok(fs.existsSync(root));
  fs.mkdirSync(path.join(root, "workspace", "locked"), { recursive: true });
  fs.writeFileSync(path.join(root, "workspace", "locked", "file"), "x");
  fs.chmodSync(path.join(root, "workspace", "locked"), 0o500);
  assert.deepEqual(json(await g.control("DELETE", `/control/workspaces/${alice}/data`)), { ok: true });
  assert.equal(fs.existsSync(root), false);
  assert.equal(g.workspaceRow(alice), undefined);
  assert.equal(g.info(alice).status, "stopped");
  assert.equal(g.runtime.runningUsers().includes(alice), false);
});

test("nothing unexpected was logged as an error", () => {
  assert.deepEqual(g.errors(), ["workspace failed to start"], "only the simulated missing image");
});

// ------------------------------------------------------------------ lifecycle (a gateway per test)

async function withGateway(options: GatewayOptions, run: (gateway: Gateway) => Promise<void>): Promise<void> {
  const gateway = await startGateway(options);
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
}

const logged = (gateway: Gateway, msg: string): boolean => gateway.logs.some((line) => (JSON.parse(line) as { msg: string }).msg === msg);

test("a working agent keeps its workspace past the idle timeout; it stops once health says idle", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice);
    const qwen = gw.runtime.qwenFor(alice);

    qwen.health.activePrompts = 1;
    await gw.manager.refreshSamples();
    assert.deepEqual(pick(gw.info(alice), ["busy", "busyReason", "idleSeconds"]), { busy: true, busyReason: "task", idleSeconds: 0 });

    gw.clock.now += 45 * MIN;
    await gw.manager.refreshSamples();
    assert.equal(gw.info(alice).lastActivityAt, gw.clock.now, "work counts as activity");
    await gw.manager.reap();
    assert.equal(gw.info(alice).status, "running", "never stopped while the agent works");

    // The agent finished; its last step, 2 minutes ago, starts the countdown.
    qwen.health.activePrompts = 0;
    qwen.health.idleSinceMs = 2 * MIN;
    gw.clock.now += 5 * MIN;
    await gw.manager.refreshSamples();
    assert.equal(gw.info(alice).busy, false);
    assert.equal(gw.info(alice).lastActivityAt, gw.clock.now - 2 * MIN, "the agent's own last step");

    gw.clock.now += 27 * MIN; // idle for 29 minutes
    await gw.manager.reap();
    assert.equal(gw.info(alice).status, "running");

    // Idle for 31 minutes by the last sample, but work has started since: the reaper asks first.
    gw.clock.now += 2 * MIN;
    qwen.health.activeWork = true;
    qwen.health.idleSinceMs = 0;
    const checks = qwen.healthChecks;
    await gw.manager.reap();
    assert.equal(qwen.healthChecks, checks + 1, "health is checked again before stopping");
    assert.equal(gw.info(alice).status, "running");
    assert.equal(gw.info(alice).busyReason, "task");

    // Done, and nobody touches it for the idle timeout.
    qwen.health.activeWork = false;
    gw.clock.now += 31 * MIN;
    qwen.health.idleSinceMs = 31 * MIN;
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.equal(gw.info(alice).status, "stopped");
    assert.equal(gw.info(alice).stopReason, "idle");
    assert.deepEqual(gw.auditActions(alice).at(-1), { action: "workspace_stopped", details: { reason: "idle" }, actorUserId: null });
    assert.deepEqual(gw.runtime.runningUsers(), []);
  }));

test("signing out while the agent works leaves the workspace running until the work is done", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    const release = async (): Promise<WorkspaceInfo> => json<WorkspaceInfo>(await gw.control("POST", `/control/workspaces/${alice}/release`));
    await gw.startReady(alice);
    const qwen = gw.runtime.qwenFor(alice);

    // No sample yet: release asks the agent itself.
    qwen.health.activePrompts = 1;
    gw.db.delete(sessions).where(eq(sessions.userId, alice)).run();
    assert.deepEqual(pick(await release(), ["status", "busy", "busyReason", "stopPending"]), {
      status: "running",
      busy: true,
      busyReason: "task",
      stopPending: true,
    });
    assert.ok(logged(gw, "last session ended while the agent is working; stopping when it is done"));
    assert.equal(gw.auditActions(alice).at(-1)?.action, "workspace_started", "not stopped");

    gw.clock.now += 2 * 60 * MIN;
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.deepEqual(pick(gw.info(alice), ["status", "stopPending"]), { status: "running", stopPending: true });

    qwen.health.activePrompts = 0;
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.deepEqual(pick(gw.info(alice), ["status", "stopReason", "stopPending"]), { status: "stopped", stopReason: "logout", stopPending: false });
    assert.deepEqual(gw.auditActions(alice).at(-1), { action: "workspace_stopped", details: { reason: "logout" }, actorUserId: null });

    // Coming back before the work is done keeps the workspace.
    gw.tokens.alice = gw.addSession(alice);
    await gw.startReady(alice);
    gw.runtime.qwenFor(alice).health.activePrompts = 1;
    gw.db.delete(sessions).where(eq(sessions.userId, alice)).run();
    assert.equal((await release()).stopPending, true);
    gw.tokens.alice = gw.addSession(alice);
    const back = json<WorkspaceInfo>(await gw.control("POST", `/control/workspaces/${alice}/start`));
    assert.deepEqual(pick(back, ["status", "stopPending"]), { status: "running", stopPending: false }, "signing in again cancels the stop");
    gw.runtime.qwenFor(alice).health.activePrompts = 0;
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.equal(gw.info(alice).status, "running");
    assert.equal(gw.runtime.startsFor(alice).length, 2);
  }));

test("an unanswered approval counts as work until qwen serve declines it, however long nobody looks", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice);
    const qwen = gw.runtime.qwenFor(alice);
    Object.assign(qwen.health, { activePrompts: 1, pendingPermissions: 1, activeWork: true, connectedClients: 0, idleSinceMs: 0 });
    await gw.manager.refreshSamples();
    assert.equal(gw.info(alice).busyReason, "task");

    // Nobody has the workspace open and the question has waited past the idle timeout: still work.
    gw.clock.now += 31 * MIN;
    qwen.health.idleSinceMs = 31 * MIN;
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.deepEqual(pick(gw.info(alice), ["status", "busyReason"]), { status: "running", busyReason: "task" });

    // qwen serve declines it (--permission-response-timeout-ms) and the turn ends: the countdown starts.
    Object.assign(qwen.health, { activePrompts: 0, pendingPermissions: 0, activeWork: false, idleSinceMs: 0 });
    await gw.manager.refreshSamples();
    assert.equal(gw.info(alice).busy, false);
    gw.clock.now += 31 * MIN;
    qwen.health.idleSinceMs = 31 * MIN;
    await gw.manager.reap();
    assert.deepEqual(pick(gw.info(alice), ["status", "stopReason"]), { status: "stopped", stopReason: "idle" });
  }));

test("MAX_BUSY_HOURS: work stops counting that long after a person last did something", () =>
  withGateway({ env: { MAX_BUSY_HOURS: "1" } }, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice); // starting it is the person's last action
    const qwen = gw.runtime.qwenFor(alice);
    qwen.health.activePrompts = 1;
    await gw.manager.refreshSamples();
    assert.equal(gw.info(alice).busy, true);

    gw.clock.now += 59 * MIN;
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.equal(gw.info(alice).busyReason, "task");

    // Past the limit a stuck agent no longer counts as work …
    gw.clock.now += 2 * MIN;
    assert.deepEqual(pick(gw.info(alice), ["busy", "busyReason"]), { busy: false, busyReason: null });
    // … and the agent's own requests (search, LLM) are activity, but not a person.
    gw.caller.userId = alice;
    assert.equal((await mcpOn(gw, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } })).status, 200);
    assert.equal(gw.info(alice).lastActivityAt, gw.clock.now);
    assert.deepEqual(pick(gw.info(alice), ["busy", "idleSeconds"]), { busy: false, idleSeconds: 61 * 60 }, "idle since the person's last action");

    // A person using the workspace makes the work count again.
    assert.equal((await gw.xhr(gw.tokens.alice, alice, { method: "POST", path: "/api/echo", body: "still there?" })).status, 200);
    assert.equal(gw.info(alice).busyReason, "task");

    // Left alone past the limit again, it is stopped for inactivity like any other workspace.
    gw.clock.now += 61 * MIN;
    await gw.manager.refreshSamples();
    assert.equal(gw.info(alice).busy, false);
    await gw.manager.reap();
    assert.equal(gw.info(alice).status, "stopped");
    assert.equal(gw.info(alice).stopReason, "idle");
  }));

test("MAX_BUSY_HOURS: an agent that keeps calling the LLM is stopped once nobody has done anything for that long", () =>
  withGateway({ env: { MAX_BUSY_HOURS: "1" } }, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice); // the person's last action
    const qwen = gw.runtime.qwenFor(alice);
    qwen.health.activePrompts = 1;
    gw.caller.userId = alice;
    const callLlm = async (): Promise<void> => {
      const reply = await request(gw.ports.service, { method: "POST", path: "/llm/v1/chat/completions", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(reply.status, 200);
    };

    // A stuck loop: a step and an LLM call every 10 minutes.
    for (let step = 1; step <= 5; step++) {
      gw.clock.now += 10 * MIN;
      qwen.health.idleSinceMs = 0;
      await callLlm();
      await gw.manager.refreshSamples();
      await gw.manager.reap();
      assert.deepEqual(pick(gw.info(alice), ["status", "busyReason"]), { status: "running", busyReason: "task" });
    }

    gw.clock.now += 11 * MIN;
    await callLlm();
    await gw.manager.refreshSamples();
    assert.equal(gw.info(alice).lastActivityAt, gw.clock.now, "its calls are still recorded");
    assert.deepEqual(pick(gw.info(alice), ["busy", "idleSeconds"]), { busy: false, idleSeconds: 61 * 60 });
    await gw.manager.reap();
    assert.deepEqual(pick(gw.info(alice), ["status", "stopReason"]), { status: "stopped", stopReason: "idle" });
  }));

test("an agent whose health check fails counts as working for a grace period after its last answer, then as done", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    const release = async (): Promise<WorkspaceInfo> => json<WorkspaceInfo>(await gw.control("POST", `/control/workspaces/${alice}/release`));
    await gw.startReady(alice);
    const qwen = gw.runtime.qwenFor(alice);
    qwen.health.activePrompts = 1;
    await gw.manager.refreshSamples(); // the last answer: working

    // qwen serve stops answering (overloaded or broken) and the person signs out.
    qwen.healthFails = true;
    gw.clock.now += MIN;
    gw.db.delete(sessions).where(eq(sessions.userId, alice)).run();
    assert.deepEqual(pick(await release(), ["status", "busyReason", "stopPending"]), { status: "running", busyReason: "task", stopPending: true });
    gw.clock.now += 3 * MIN;
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.deepEqual(pick(gw.info(alice), ["status", "busyReason", "stopPending"]), { status: "running", busyReason: "task", stopPending: true });
    const warnings = gw.logs.filter((line) => (JSON.parse(line) as { msg: string }).msg === "Qwen Code did not answer its status check");
    assert.equal(warnings.length, 1, "warned once, not at every check");

    // Five minutes after the last answer it no longer counts as working.
    gw.clock.now = gw.clock.now - 4 * MIN + AGENT_UNKNOWN_GRACE_MS;
    await gw.manager.refreshSamples();
    assert.deepEqual(pick(gw.info(alice), ["busy", "busyReason"]), { busy: false, busyReason: null });
    await gw.manager.reap();
    assert.deepEqual(pick(gw.info(alice), ["status", "stopReason", "stopPending"]), { status: "stopped", stopReason: "logout", stopPending: false });
  }));

test("release counts the sessions again after asking the agent: signing in meanwhile keeps the workspace", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice);
    const qwen = gw.runtime.qwenFor(alice);
    gw.db.delete(sessions).where(eq(sessions.userId, alice)).run();
    qwen.onHealth = () => {
      qwen.onHealth = null;
      gw.tokens.alice = gw.addSession(alice);
    };
    const released = json<WorkspaceInfo>(await gw.control("POST", `/control/workspaces/${alice}/release`));
    assert.equal(qwen.onHealth, null, "the agent was asked");
    assert.deepEqual(pick(released, ["status", "stopPending"]), { status: "running", stopPending: false });
    assert.deepEqual(gw.runtime.runningUsers(), [alice]);
  }));

test("a container whose stop failed is never taken over again; reconcile removes it once Docker can", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice);
    const container = gw.runtime.containerFor(alice).id;
    gw.runtime.failStops = new Error("Docker did not answer");
    const stopped = await gw.manager.stop(alice, "admin");
    assert.deepEqual(pick(stopped, ["status", "ready", "lastError"]), {
      status: "error",
      ready: false,
      lastError: "could not stop the workspace container: Docker did not answer",
    });
    assert.equal(gw.manager.upstream(alice), null);
    assert.equal(gw.workspaceRow(alice)?.containerId, container, "remembered for a restarted gateway");

    await gw.manager.reconcile();
    assert.equal(gw.info(alice).status, "error", "not adopted");
    assert.ok(gw.runtime.containers.has(container));
    assert.ok(logged(gw, "could not remove a workspace container left behind by a failed stop"));

    gw.manager.shutdown();
    const fresh = new WorkspaceManager({ config: gw.config, db: gw.db, runtime: gw.runtime, llm: gw.llmQueue, connections: gw.connections, log: gw.log, now: () => gw.clock.now });
    await fresh.init();
    gw.useManager(fresh);
    assert.equal(fresh.info(alice).status, "error", "a restarted gateway does not adopt it either");
    assert.ok(gw.runtime.containers.has(container));

    gw.runtime.failStops = null;
    await fresh.reconcile();
    assert.equal(gw.runtime.containers.has(container), false);
    assert.equal(gw.workspaceRow(alice)?.containerId, null);
    assert.ok(logged(gw, "removed a workspace container left behind by a failed stop"));
    await gw.startReady(alice);
    assert.equal(gw.runtime.startsFor(alice).length, 2);
  }));

test("while a user's data is being deleted no start gets through; a failed stop deletes nothing", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice);
    const root = userPaths(gw.dataDir, alice).root;

    let finishStop!: () => void;
    gw.runtime.stopGate = new Promise<void>((resolve) => (finishStop = resolve));
    const stopping = gw.manager.stop(alice, "admin");
    const queued = gw.manager.start(alice); // waits for the stop
    const deleting = gw.manager.deleteData(alice);
    const refused = await gw.control("POST", `/control/workspaces/${alice}/start`);
    assert.deepEqual([refused.status, json(refused)], [409, { error: "deleting", message: "This workspace is being deleted." }]);
    const page = await gw.navigate(gw.tokens.alice, alice);
    assert.equal(page.status, 503);
    assert.ok(page.body.includes("This workspace is being deleted."));

    gw.runtime.stopGate = null;
    finishStop();
    await stopping;
    await assert.rejects(queued, DeletingError, "the start queued behind the stop");
    await deleting;
    assert.equal(fs.existsSync(root), false);
    assert.equal(gw.workspaceRow(alice), undefined);
    assert.equal(gw.runtime.startsFor(alice).length, 1, "nothing started");

    // Docker can't remove the container: the data stays, and the web app is told.
    await gw.startReady(alice);
    gw.runtime.failStops = new Error("Docker did not answer");
    const failed = await gw.control("DELETE", `/control/workspaces/${alice}/data`);
    assert.equal(failed.status, 500);
    assert.deepEqual(json(failed), { error: "stop_failed", message: "could not stop the workspace container, so its data was not deleted: Docker did not answer" });
    assert.ok(fs.existsSync(root));
    assert.equal(gw.info(alice).status, "error");

    gw.runtime.failStops = null;
    assert.deepEqual(json(await gw.control("DELETE", `/control/workspaces/${alice}/data`)), { ok: true }, "trying again removes the leftover container first");
    assert.equal(fs.existsSync(root), false);
    assert.deepEqual(gw.runtime.runningUsers(), []);
  }));

test("the service API knows a workspace by its container's address, also once Docker gives that address to another", () =>
  withGateway({}, async (gw) => {
    const { alice, bob } = gw.ids;
    // The real caller lookup (the shared harness server takes the caller from gw.caller instead).
    const service = createServiceServer({ config: gw.config, db: gw.db, manager: gw.manager, llm: gw.llmQueue, log: gw.log, search: { search: async () => "" } });
    const port = await listenLocal(service);
    try {
      const requests = (userId: number): number => gw.db.select().from(llmUsage).where(eq(llmUsage.userId, userId)).get()?.requests ?? 0;
      const callFrom = (address: string): Promise<Reply> =>
        request(port, { method: "POST", path: "/llm/v1/chat/completions", headers: { "content-type": "application/json" }, body: "{}", localAddress: address });

      await gw.startReady(alice);
      const address = gw.runtime.qwenFor(alice).host;
      assert.equal((await callFrom(address)).status, 200);
      assert.equal(requests(alice), 1);
      assert.equal((await callFrom("127.0.0.1")).status, 403, "no workspace has this address");

      // Alice's container dies unnoticed, and Docker gives its address to Bob's.
      await gw.runtime.crash(alice);
      await gw.startReady(bob);
      assert.equal(gw.runtime.qwenFor(bob).host, address);
      assert.equal((await callFrom(address)).status, 200);
      assert.deepEqual([requests(alice), requests(bob)], [1, 1], "Bob's calls are Bob's");
      assert.ok(logged(gw, "a workspace's address now belongs to another workspace"));
      await waitFor(() => gw.info(alice).status === "stopped", "Alice's crash to be noticed");
      assert.equal(gw.info(alice).stopReason, "error");
    } finally {
      await closeServer(service);
    }
  }));

test("the session sweep closes connections of sessions that ended, or of an admin who moved on", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice);
    const second = gw.addSession(alice);
    gw.actAs(gw.tokens.admin, alice);
    const ended = await gw.openSocket(gw.tokens.alice, alice);
    const kept = await gw.openSocket(second, alice);
    const viewing = await gw.openSocket(gw.tokens.admin, alice);
    assert.ok("socket" in ended && "socket" in kept && "socket" in viewing);
    assert.deepEqual(gw.info(alice).connections, { owner: 2, admin: 1 });
    assert.equal(closeEndedSessions(gw.db, gw.connections, gw.clock.now), 0, "every session still uses the workspace");

    // Removed without a disconnect call reaching the gateway; the admin went back to their own workspace.
    const endedClosed = closed(ended.socket);
    const viewingClosed = closed(viewing.socket);
    gw.db.delete(sessions).where(eq(sessions.id, hashSessionToken(gw.tokens.alice))).run();
    gw.actAs(gw.tokens.admin, null);
    assert.equal(closeEndedSessions(gw.db, gw.connections, gw.clock.now), 2);
    assert.deepEqual([await endedClosed, await viewingClosed], [4001, 4001]);
    assert.equal(kept.socket.readyState, WebSocket.OPEN);
    await waitFor(() => gw.info(alice).connections.admin === 0 && gw.info(alice).connections.owner === 1, "the closed connections to be gone");
  }));

test("a system-defaults.json without a model fails the start, naming the file", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    const file = path.join(gw.config.qwenConfigDir, "system-defaults.json");
    const expected = { error: "start_failed", message: `the Qwen Code settings file ${file} defines no model: add at least one entry with an "id" under modelProviders.openai` };
    fs.writeFileSync(file, JSON.stringify({ modelProviders: { openai: [{ name: "No id" }] } }));
    const reply = await gw.control("POST", `/control/workspaces/${alice}/start`);
    assert.deepEqual([reply.status, json(reply)], [500, expected]);
    fs.rmSync(file);
    const missing = await gw.control("POST", `/control/workspaces/${alice}/start`);
    assert.deepEqual([missing.status, json(missing)], [500, expected], "models are no longer configured in the environment");
    assert.equal(gw.runtime.starts.length, 0);
  }));

function mcpOn(gw: Gateway, body: unknown): Promise<Reply> {
  return request(gw.ports.service, {
    method: "POST",
    path: "/mcp/search",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

test("CPU use, averaged between two samples, counts as work", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    await gw.startReady(alice);
    const cpu = (seconds: number): void => void gw.runtime.cpuSeconds.set(alice, seconds);
    const busy = (): Pick<WorkspaceInfo, "busy" | "busyReason"> => pick(gw.info(alice), ["busy", "busyReason"]);

    cpu(100);
    await gw.manager.refreshSamples();
    assert.deepEqual(busy(), { busy: false, busyReason: null }, "one sample is no average");
    assert.equal(gw.info(alice).memoryBytes, gw.runtime.memoryBytes);

    gw.clock.now += 15_000;
    cpu(107.5); // 7.5 s in 15 s: 0.5 cores
    await gw.manager.refreshSamples();
    assert.deepEqual(busy(), { busy: true, busyReason: "cpu" });
    assert.equal(gw.info(alice).lastActivityAt, gw.clock.now);

    gw.clock.now += 15_000;
    cpu(109); // 0.1 cores: background noise
    await gw.manager.refreshSamples();
    assert.deepEqual(busy(), { busy: false, busyReason: null });

    gw.clock.now += 15_000;
    cpu(112); // 0.2 cores
    await gw.manager.refreshSamples();
    assert.equal(busy().busyReason, "cpu");

    gw.clock.now += 15_000;
    cpu(1); // the counter went backwards (a restart): no measurement
    await gw.manager.refreshSamples();
    assert.deepEqual(busy(), { busy: false, busyReason: null });

    // A long build keeps the workspace past the idle timeout …
    gw.clock.now += 31 * MIN;
    cpu(1 + 31 * 60 * 2);
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.equal(gw.info(alice).status, "running");
    assert.equal(busy().busyReason, "cpu");

    // … and once it is quiet, the countdown starts (sampling every 15 s, like the background task).
    const busyUntil = 1 + 31 * 60 * 2;
    gw.clock.now += 15_000;
    cpu(busyUntil + 0.15);
    await gw.manager.refreshSamples();
    assert.deepEqual(busy(), { busy: false, busyReason: null });
    gw.clock.now += 31 * MIN;
    cpu(busyUntil + 0.15 + 31 * 60 * 0.01);
    await gw.manager.refreshSamples();
    await gw.manager.reap();
    assert.equal(gw.info(alice).status, "stopped");
    assert.equal(gw.info(alice).stopReason, "idle");
  }));

test("after a gateway restart, running containers are adopted with their token and the rest removed", () =>
  withGateway({ env: { MAX_RUNNING_WORKSPACES: "4" } }, async (gw) => {
    const { alice, bob, carol } = gw.ids;
    await gw.startReady(alice);
    await gw.startReady(bob);
    await gw.startReady(carol);
    await gw.manager.stop(carol, "admin");
    // A row that says running, without a container.
    gw.db.update(workspaces).set({ status: "running" }).where(eq(workspaces.userId, carol)).run();
    const aliceToken = gw.runtime.startsFor(alice)[0]!.options.credential;
    const { host: aliceHost, port: alicePort } = gw.runtime.qwenFor(alice);
    const bobContainer = gw.runtime.containerFor(bob).id;
    gw.runtime.forgetCredential(bobContainer); // its token cannot be read back
    const orphan = gw.runtime.addOrphan(9999);
    const unlabelled = gw.runtime.addOrphan(null);
    const starts = gw.runtime.starts.length;

    gw.manager.shutdown();
    const fresh = new WorkspaceManager({
      config: gw.config,
      db: gw.db,
      runtime: gw.runtime,
      llm: gw.llmQueue,
      connections: gw.connections,
      log: gw.log,
      now: () => gw.clock.now,
    });
    await fresh.init();
    gw.useManager(fresh);

    assert.equal(gw.runtime.containers.has(orphan), false);
    assert.equal(gw.runtime.containers.has(unlabelled), false);
    assert.equal(gw.runtime.containers.has(bobContainer), false, "a container the gateway cannot authenticate to is removed");
    assert.ok(logged(gw, "cannot adopt workspace container: its credential is unknown"));
    assert.equal(fresh.info(alice).status, "starting", "adopted; readiness is checked again");
    assert.equal(fresh.info(alice).lastActivityAt, gw.clock.now);
    await gw.waitReady(alice);
    assert.equal(gw.runtime.starts.length, starts, "nothing was started");
    assert.deepEqual(fresh.upstream(alice), { agent: "qwen", host: aliceHost, port: alicePort, credential: aliceToken });

    const api = await gw.xhr(gw.tokens.alice, alice, { path: "/api/sessions" });
    assert.equal(api.status, 200, "the adopted workspace is proxied with the token it was started with");
    assert.equal(gw.runtime.qwenFor(alice).requests.at(-1)!.headers.authorization, `Bearer ${aliceToken}`);

    assert.equal(fresh.info(bob).status, "stopped");
    const carolInfo = fresh.info(carol);
    assert.equal(carolInfo.status, "stopped", "a row that said running without a container is marked stopped");
    assert.equal(gw.db.select().from(workspaces).where(and(eq(workspaces.userId, carol), eq(workspaces.status, "stopped"))).get()?.userId, carol);

    await gw.startReady(bob);
    assert.notEqual(gw.runtime.startsFor(bob).at(-1)!.options.credential, gw.runtime.startsFor(bob)[0]!.options.credential);
  }));

test("invalid admin Qwen Code settings fail the start with a clear message", () =>
  withGateway({}, async (gw) => {
    const { alice } = gw.ids;
    const file = path.join(gw.config.qwenConfigDir, "settings.json");
    fs.mkdirSync(gw.config.qwenConfigDir, { recursive: true });
    fs.writeFileSync(file, '{ "ui": { "theme": "Dracula" }\n');

    const reply = await gw.control("POST", `/control/workspaces/${alice}/start`);
    assert.equal(reply.status, 500);
    const { error, message } = json<{ error: string; message: string }>(reply);
    assert.equal(error, "start_failed");
    assert.match(message, new RegExp(`^the Qwen Code settings file ${escapeRegExp(file)} is not valid JSON: `));
    assert.deepEqual(pick(gw.info(alice), ["status", "lastError"]), { status: "error", lastError: message });
    assert.deepEqual(gw.auditActions(alice).at(-1), { action: "workspace_error", details: { error: message }, actorUserId: null });
    assert.equal(gw.runtime.starts.length, 0, "no container was created");

    const page = await gw.navigate(gw.tokens.alice, alice);
    assert.equal(page.status, 503);
    assert.ok(page.body.includes("is not valid JSON"));

    fs.writeFileSync(file, "[]");
    const notObject = await gw.control("POST", `/control/workspaces/${alice}/start`);
    assert.equal(json<{ message: string }>(notObject).message, `the Qwen Code settings file ${file} must contain a JSON object`);

    fs.writeFileSync(file, '{ "ui": { "theme": "Dracula" } } // fixed\n');
    const retry = await request(gw.agentPort(alice), {
      method: "POST",
      path: "/__portal/start",
      headers: { cookie: cookie(gw.tokens.alice), origin: gw.agentOrigin(alice), "sec-fetch-site": "same-origin" },
    });
    assert.equal(retry.status, 303);
    await gw.waitReady(alice);
    assert.deepEqual(gw.errors(), ["workspace failed to start", "workspace failed to start"]);
  }));

test("every start renders the workspace's Qwen Code settings, passwd and group", () =>
  withGateway({}, async (gw) => {
    const { alice, bob } = gw.ids;
    const dir = gw.config.qwenConfigDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      [
        "// Portal-wide Qwen Code settings",
        "{",
        '  "ui": { "theme": "Dracula" },',
        '  "telemetry": { "enabled": true }, /* the portal turns this off again */',
        '  "general": { "enableAutoUpdate": true },',
        '  "permissions": { "deny": ["run_shell_command(rm)"] },',
        '  "mcpServers": { "search": { "httpUrl": "https://search.example/mcp" } }',
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "system-defaults.json"),
      JSON.stringify({ modelProviders: { openai: [{ id: "big", name: "Big", baseUrl: "https://api.example.com/v1", apiKey: "sk-secret" }] } }),
    );
    await gw.startReady(alice);

    const paths = userPaths(gw.dataDir, alice);
    const read = (file: string): string => fs.readFileSync(file, "utf8");
    const settingsFile = path.join(paths.agentSettings("qwen"), "settings.json");
    const defaultsFile = path.join(paths.agentSettings("qwen"), "system-defaults.json");
    const settings = JSON.parse(read(settingsFile)) as Record<string, Record<string, unknown>>;
    const defaults = JSON.parse(read(defaultsFile)) as SettingsObject;
    const service = `http://${gw.config.workspace.gatewayIp}:${gw.config.servicePort}`;
    assert.equal(service, "http://172.29.0.1:4001");

    assert.deepEqual(settings.ui, { theme: "Dracula" }, "the admin's settings are kept");
    assert.deepEqual(settings.telemetry, { enabled: false, logPrompts: false });
    assert.equal(settings.general!.enableAutoUpdate, false);
    assert.deepEqual(settings.privacy, { usageStatisticsEnabled: false });
    assert.deepEqual(settings.permissions!.deny, ["run_shell_command(rm)", "web_fetch"]);
    const servers = settings.mcpServers as Record<string, Record<string, unknown>>;
    assert.equal(servers.search!.httpUrl, `${service}/mcp/search`, "search goes to the gateway");
    assert.ok(servers.browser, "WORKSPACE_BROWSER is on by default");
    assert.deepEqual(defaults.modelProviders, {
      openai: [{ id: "big", name: "Big", baseUrl: `${service}/llm/v1`, envKey: "PORTAL_LLM_KEY" }],
    });
    assert.equal(read(defaultsFile).includes("sk-secret"), false, "no API key reaches a workspace");
    assert.deepEqual(gw.runtime.startsFor(alice)[0]!.settings, settings, "rendered before the container started");

    const uid = gw.config.workspace.uidBase + alice;
    assert.equal(read(paths.passwd).split("\n").find((line) => line.startsWith("user:")), `user:x:${uid}:${uid}:Workspace user:/home/user:/bin/bash`);
    assert.equal(read(paths.group).split("\n").find((line) => line.startsWith("user:")), `user:x:${uid}:`);
    for (const file of [settingsFile, defaultsFile, paths.passwd, paths.group]) assert.equal(fs.statSync(file).mode & 0o777, 0o644, file);

    await gw.startReady(bob);
    const bobUid = gw.config.workspace.uidBase + bob;
    assert.ok(read(userPaths(gw.dataDir, bob).passwd).includes(`user:x:${bobUid}:${bobUid}:`), "each workspace has its own UID");

    // Changed admin settings apply at the next start.
    fs.writeFileSync(path.join(dir, "settings.json"), '{ "ui": { "theme": "GitHub" }, "telemetry": { "enabled": true } }');
    await gw.manager.stop(alice, "admin");
    await gw.startReady(alice);
    const restarted = JSON.parse(read(settingsFile)) as Record<string, Record<string, unknown>>;
    assert.deepEqual(restarted.ui, { theme: "GitHub" });
    assert.deepEqual(restarted.telemetry, { enabled: false, logPrompts: false });
    assert.deepEqual(restarted.permissions, { deny: ["web_fetch"] });
  }));
