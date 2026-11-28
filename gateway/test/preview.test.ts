// The preview ports (preview-proxy.ts): the person's browser reaching a web app that runs in their workspace, on
// the agent port + PREVIEW_PORT_OFFSET. The same checks as the agent ports, a chosen app port per preview port, the
// app seeing a local browser and none of the portal's cookies, and responses that can't escape the preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { hashSessionToken, type WorkspaceRef, type WorkspaceServers } from "@portal/core";
import { BOTH, cookie, json, NAVIGATE, request, startGateway, withGateway, type Gateway, type Reply, type WorkspaceChoice } from "./harness.ts";
import { previewCookieName } from "../src/proxy/preview-proxy.ts";

const QWEN_PRIVATE: WorkspaceRef = { agent: "qwen", kind: "private" };
const QWEN_ONLINE: WorkspaceRef = { agent: "qwen", kind: "online" };
const DSH_PRIVATE: WorkspaceRef = { agent: "dsh", kind: "private" };

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** A dev server in the workspace (on its fake container's address): records what it gets, answers per path. */
async function startApp(host: string): Promise<{ port: number; seen: Seen[]; sockets: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const sockets: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (req.url === "/moved") {
      res.writeHead(302, { location: `http://localhost:${port}/next?a=1` });
      return res.end();
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": ["portal_session=stolen; Path=/; HttpOnly", "app=1; Path=/"],
      "x-frame-options": "DENY",
      "content-security-policy": "img-src 'self'; frame-ancestors 'none'",
      "cache-control": "public, max-age=600",
    });
    res.end("<h1>the game</h1>");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    sockets.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    sockets,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function previewNavigate(g: Gateway, token: string | null, userId: number, path: string, extra: Record<string, string> = {}, workspace: WorkspaceChoice = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...NAVIGATE, ...extra };
  if (token) headers.cookie = [cookie(token), extra.cookie].filter(Boolean).join("; ");
  return request(g.previewPort(userId, workspace), { path, headers });
}

/** Chooses `port` on a workspace's preview port; returns the cookie pair the browser keeps. */
async function choose(g: Gateway, token: string, userId: number, port: number | string, workspace: WorkspaceChoice = {}): Promise<string> {
  const reply = await previewNavigate(g, token, userId, `/__portal/port/${port}/`, {}, workspace);
  assert.equal(reply.status, 303, reply.body);
  return String(reply.headers["set-cookie"]?.[0]).split(";")[0]!;
}

/** A WebSocket to a workspace's preview port, as a page does it: the open socket, or the status it was refused with. */
function openSocket(g: Gateway, userId: number, headers: Record<string, string>, workspace: WorkspaceChoice = {}): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${g.previewPort(userId, workspace)}/live?room=1`, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    socket.once("error", () => undefined);
  });
}

async function withApp(run: (g: Gateway, app: Awaited<ReturnType<typeof startApp>>, alice: number) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const g = await startGateway({ env });
  const alice = g.ids.alice;
  await g.startReady(alice);
  const app = await startApp(g.manager.upstream(alice, QWEN_PRIVATE)!.host);
  try {
    await run(g, app, alice);
  } finally {
    await app.close();
    await g.close();
  }
}

test("choosing a port: a cookie of this preview port, then a redirect to the path asked for (only ever on this origin)", () =>
  withApp(async (g, app, alice) => {
    const reply = await previewNavigate(g, g.tokens.alice, alice, `/__portal/port/${app.port}/game/index.html?level=2`);
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, "/game/index.html?level=2");
    assert.deepEqual(reply.headers["set-cookie"], [`${previewCookieName(g.previewPort(alice))}=${app.port}; Path=/; HttpOnly; SameSite=Lax`]);
    assert.equal((await previewNavigate(g, g.tokens.alice, alice, `/__portal/port/${app.port}`)).headers.location, "/");
    for (const path of [`/__portal/port/${app.port}//evil.example/x`, `/__portal/port/${app.port}/\\evil.example`]) {
      assert.equal((await previewNavigate(g, g.tokens.alice, alice, path)).headers.location, "/", path);
    }
    // Not a port, a privileged one, or the agent's own: refused.
    const agentPort = g.manager.upstream(alice, QWEN_PRIVATE)!.port;
    for (const port of ["80", "0", "70000", "abc", "", String(agentPort)]) {
      const page = await previewNavigate(g, g.tokens.alice, alice, `/__portal/port/${port}/`);
      assert.equal(page.status, 400, port);
      assert.match(page.body, /can&#39;t be shown here/);
      const refused = await request(g.previewPort(alice), {
        path: `/__portal/port/${port}/`,
        headers: { cookie: cookie(g.tokens.alice), "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
      });
      assert.equal(json<{ error: string }>(refused).error, "bad_port", port);
    }
    assert.equal((await request(g.previewPort(alice), { method: "POST", path: `/__portal/port/${app.port}/`, headers: { cookie: cookie(g.tokens.alice), "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${g.previewPort(alice)}` } })).status, 405);
    assert.equal(app.seen.length, 0, "nothing reached the app");
  }));

test("the app sees a local browser: Host and Origin localhost:<port>, its own cookies only, no forwarding headers", () =>
  withApp(async (g, app, alice) => {
    const chosen = await choose(g, g.tokens.alice, alice, app.port);
    const origin = `http://127.0.0.1:${g.previewPort(alice)}`;
    const reply = await request(g.previewPort(alice), {
      method: "POST",
      path: "/api/score?x=1",
      headers: {
        cookie: `${cookie(g.tokens.alice)}; ${chosen}; app=1`,
        origin,
        referer: `${origin}/game`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "x-forwarded-for": "6.6.6.6",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(reply.status, 200, reply.body);
    const [seen] = app.seen;
    assert.equal(seen?.method, "POST");
    assert.equal(seen?.url, "/api/score?x=1");
    assert.equal(seen?.headers.host, `localhost:${app.port}`);
    assert.equal(seen?.headers.origin, `http://localhost:${app.port}`);
    assert.equal(seen?.headers.referer, `http://localhost:${app.port}/game`);
    assert.equal(seen?.headers.cookie, "theme=dark; app=1", "no portal cookie reaches the app");
    assert.equal(seen?.headers["x-forwarded-for"], undefined);
  }));

test("over HTTPS the portal is on the default port, and every origin the gateway names is https", () =>
  withApp(async (g, app, alice) => {
    const chosen = await choose(g, g.tokens.alice, alice, app.port);
    const page = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen, referer: `https://127.0.0.1:${g.previewPort(alice)}/menu` });
    assert.equal(app.seen.at(-1)?.headers.referer, `http://localhost:${app.port}/menu`);
    const [own, confined] = String(page.headers["content-security-policy"]).split(", ");
    assert.equal(own, "img-src 'self'; frame-ancestors https://127.0.0.1");
    assert.match(confined!, new RegExp(`connect-src 'self' wss://127\\.0\\.0\\.1:${g.previewPort(alice)};`));
    const signedOut = await g.navigate(null, alice);
    assert.ok(signedOut.body.includes('href="https://127.0.0.1/login" target="_top"'));
    assert.equal(signedOut.headers["content-security-policy"]?.toString().split("; ").at(-1), "frame-ancestors https://127.0.0.1");
  }, { PORTAL_HTTPS: "true" }));

test("the app's answer: no portal cookies, framed by nothing but the portal, redirects kept on the preview", () =>
  withApp(async (g, app, alice) => {
    const chosen = await choose(g, g.tokens.alice, alice, app.port);
    const page = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<h1>the game</h1>");
    assert.deepEqual(page.headers["set-cookie"], ["app=1; Path=/"]);
    assert.equal(page.headers["x-frame-options"], undefined);
    assert.equal(page.headers["cache-control"], "private, no-store");
    const host = "127.0.0.1";
    const ancestors = `frame-ancestors http://${host}:${g.config.webPort}`;
    const csp = String(page.headers["content-security-policy"]);
    const policies = csp.split(", ");
    assert.equal(policies[0], `img-src 'self'; ${ancestors}`, "the app's own policy, its frame-ancestors replaced");
    // Private: confined to the preview origin.
    assert.match(policies[1]!, /^default-src 'self' data: blob:; .*connect-src 'self' ws:\/\/127\.0\.0\.1:\d+; form-action 'self'; base-uri 'self'; frame-ancestors /);
    const moved = await previewNavigate(g, g.tokens.alice, alice, "/moved", { cookie: chosen });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.location, "/next?a=1");
  }));

test("an Online workspace's app is not confined to its origin (it may load from the internet, as the workspace may)", async () => {
  const g = await startGateway();
  try {
    const alice = g.ids.alice;
    await g.startReady(alice, QWEN_ONLINE);
    const app = await startApp(g.manager.upstream(alice, QWEN_ONLINE)!.host);
    try {
      const chosen = await choose(g, g.tokens.alice, alice, app.port, QWEN_ONLINE);
      const page = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen }, QWEN_ONLINE);
      assert.equal(page.status, 200);
      assert.equal(String(page.headers["content-security-policy"]).split(", ").length, 1);
      // Her Private preview port doesn't reach the Online workspace (its own cookie, too, is the Online port's).
      const other = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
      assert.equal(other.status, 409);
      assert.ok(other.body.includes("<h1>Your Online Qwen Code workspace is running, not this one</h1>"), other.body);
    } finally {
      await app.close();
    }
  } finally {
    await g.close();
  }
});

test("the same checks as the agent ports: signed out, another user's preview, same-site requests that aren't page loads", () =>
  withApp(async (g, app, alice) => {
    const chosen = await choose(g, g.tokens.alice, alice, app.port);
    const signedOut = await previewNavigate(g, null, alice, "/", { cookie: chosen });
    assert.equal(signedOut.status, 401);
    assert.match(signedOut.body, /You&#39;re signed out/);
    const other = await previewNavigate(g, g.tokens.bob, alice, "/", { cookie: chosen });
    assert.equal(other.status, 403);
    assert.match(other.body, /This workspace isn&#39;t open here/);
    // A page on another port of the host (another workspace, the portal) loading it as an image or script.
    const asset = await request(g.previewPort(alice), {
      path: "/",
      headers: { cookie: `${cookie(g.tokens.alice)}; ${chosen}`, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
    });
    assert.equal(asset.status, 403);
    assert.equal(json<{ error: string }>(asset).error, "forbidden_same_site");
    const foreign = await request(g.previewPort(alice), {
      method: "POST",
      path: "/api",
      headers: { cookie: `${cookie(g.tokens.alice)}; ${chosen}`, origin: g.agentOrigin(alice), "sec-fetch-site": "same-site" },
    });
    assert.equal(foreign.status, 403);
    // "Open externally": a same-site page load in a tab of its own works here (not on the agent port).
    const tab = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen, "sec-fetch-dest": "document" });
    assert.equal(tab.status, 200);
    const agentTab = await g.navigate(g.tokens.alice, alice, "/", { "sec-fetch-dest": "document" });
    assert.equal(agentTab.status, 403);
    assert.equal(app.seen.length, 1, "only the page load reached the app");
  }));

test("no app chosen, nothing listening, a stopped workspace: a page for page loads, JSON otherwise", () =>
  withApp(async (g, app, alice) => {
    const unchosen = await previewNavigate(g, g.tokens.alice, alice, "/");
    assert.equal(unchosen.status, 404);
    assert.match(unchosen.body, /No web server chosen/);
    const xhr = await request(g.previewPort(alice), { path: "/api", headers: { cookie: cookie(g.tokens.alice), "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } });
    assert.equal(json<{ error: string }>(xhr).error, "no_app_chosen");

    const port = app.port;
    await app.close();
    const chosen = await choose(g, g.tokens.alice, alice, port);
    const down = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
    assert.equal(down.status, 502);
    assert.match(down.body, new RegExp(`Nothing answers on port ${port}`));
    assert.match(String(down.headers["content-security-policy"]), new RegExp(`frame-ancestors http://127\\.0\\.0\\.1:${g.config.webPort}$`), "framed by nothing but the portal");

    await g.manager.stop(alice, "test");
    const stopped = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
    assert.equal(stopped.status, 503);
    assert.match(stopped.body, /<h1>Your Private Qwen Code workspace is stopped<\/h1>/);
  }));

test("an app that answers with a status no HTTP response may have is one that does not answer", () =>
  withApp(async (g, app, alice) => {
    const raw = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => socket.end("HTTP/1.1 099 x\r\nContent-Length: 0\r\n\r\n"));
    });
    await new Promise<void>((resolve) => raw.listen(0, g.manager.upstream(alice, QWEN_PRIVATE)!.host, resolve));
    try {
      const { port } = raw.address() as AddressInfo;
      const bad = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: await choose(g, g.tokens.alice, alice, port) });
      assert.equal(bad.status, 502);
      assert.match(bad.body, new RegExp(`Nothing answers on port ${port}`));
      // The gateway still serves.
      const page = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: await choose(g, g.tokens.alice, alice, app.port) });
      assert.equal(page.status, 200);
    } finally {
      raw.close();
    }
  }));

test("a harness's preview port never serves another harness's apps: another_running for a page, a fetch and a socket", () =>
  withApp(async (g, app, alice) => {
    // Qwen Code runs, with the app. On DeepSeek Harness's preview port a page of hers has chosen that app's port.
    const chosen = await choose(g, g.tokens.alice, alice, app.port, DSH_PRIVATE);
    const port = g.previewPort(alice, DSH_PRIVATE);
    assert.equal(port, g.agentPort(alice, DSH_PRIVATE) + 10_000);
    assert.equal(chosen, `${previewCookieName(port)}=${app.port}`);
    const cookies = `${cookie(g.tokens.alice)}; ${chosen}`;

    const page = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen }, DSH_PRIVATE);
    assert.equal(page.status, 409);
    assert.ok(page.body.includes("<h1>Your Private Qwen Code workspace is running, not this one</h1>"), page.body);
    const fetched = await request(port, { path: "/api", headers: { cookie: cookies, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } });
    assert.deepEqual([fetched.status, json(fetched)], [
      409,
      { error: "another_running", message: "Your Private Qwen Code workspace is running, not this one (Private DeepSeek Harness)." },
    ]);
    assert.equal(await openSocket(g, alice, { origin: `http://127.0.0.1:${port}`, cookie: cookies }, DSH_PRIVATE), 409);

    // Nor is what was chosen there chosen on Qwen Code's own preview port: the cookie is its port's.
    const own = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
    assert.equal(own.status, 404);
    assert.match(own.body, /No web server chosen/);
    assert.deepEqual([app.seen.length, app.sockets.length], [0, 0], "nothing reached the app");
  }, BOTH.env));

test("Try again on a preview port starts that port's workspace, not the agent a start from the portal would run", () =>
  withGateway(BOTH, async (g) => {
    const { alice } = g.ids;
    const port = g.previewPort(alice, DSH_PRIVATE);
    const stopped = await previewNavigate(g, g.tokens.alice, alice, "/", {}, DSH_PRIVATE);
    assert.equal(stopped.status, 503);
    assert.match(stopped.body, /<h1>Your Private DeepSeek Harness workspace is stopped<\/h1>/);
    assert.equal(g.runtime.starts.length, 0, "a page load starts nothing");

    // She has chosen no agent: the portal would start Qwen Code, the first enabled one.
    const retry = await request(port, {
      method: "POST",
      path: "/__portal/start",
      headers: { cookie: cookie(g.tokens.alice), origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
    });
    assert.deepEqual([retry.status, retry.headers.location], [303, "/"]);
    await g.waitReady(alice);
    assert.deepEqual(g.runtime.startsFor(alice).map((record) => record.options.ref), [DSH_PRIVATE]);
    assert.equal(g.manager.upstream(alice, QWEN_PRIVATE), null);
  }));

test("GET /control/workspaces/:id/servers: the web servers of the workspace that runs, looked up once however many ask, and no activity", () =>
  withGateway({}, async (g) => {
    const { alice, bob } = g.ids;
    const servers = async (userId: number) => json<WorkspaceServers>(await g.control("GET", `/control/workspaces/${userId}/servers`));
    const socket = (address: string, port: number, state = "0A") =>
      `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 200020        0 7 1 0000000000000000 100 0 0 10 0`;

    assert.deepEqual(await servers(alice), { workspace: null, servers: [] }, "stopped");
    assert.deepEqual(g.runtime.socketReads, [], "no container is asked");

    await g.startReady(alice);
    const agentPort = g.manager.upstream(alice, QWEN_PRIVATE)!.port;
    g.runtime.socketTables = [socket("00000000", 3000), socket("0100007F", 5173), socket("00000000", agentPort), socket("00000000", 8080, "01")].join("\n");
    const active = g.info(alice).lastActivityAt;
    g.clock.now += 60_000;
    const listed = { workspace: QWEN_PRIVATE, servers: [{ port: 3000, reachable: true }, { port: 5173, reachable: false }] };
    assert.deepEqual(await Promise.all([servers(alice), servers(alice)]), [listed, listed], "not the agent's own port, nor a socket that does not listen");
    assert.deepEqual(await servers(alice), listed);
    assert.equal(g.runtime.socketReads.length, 1, "three asked, the container once");
    assert.equal(g.info(alice).lastActivityAt, active, "looking is no activity");
    assert.deepEqual(await servers(bob), { workspace: null, servers: [] }, "another user's workspace says nothing");

    // Later, a container that can't be asked has none.
    g.clock.now += 2_000;
    g.runtime.socketTables = new Error("the container is paused");
    assert.deepEqual(await servers(alice), { workspace: QWEN_PRIVATE, servers: [] });
    assert.equal(g.runtime.socketReads.length, 2);

    await g.manager.stop(alice, "test");
    assert.deepEqual(await servers(alice), { workspace: null, servers: [] });
    assert.equal((await g.control("GET", "/control/workspaces/zero/servers")).status, 400);
  }));

test("WebSockets reach the chosen app as a local browser's, after the same checks, and close with the session", () =>
  withApp(async (g, app, alice) => {
    const chosen = await choose(g, g.tokens.alice, alice, app.port);
    const origin = `http://127.0.0.1:${g.previewPort(alice)}`;
    const open = (headers: Record<string, string>): Promise<WebSocket | number> => openSocket(g, alice, headers);
    const socket = await open({ origin, cookie: `${cookie(g.tokens.alice)}; ${chosen}` });
    assert.ok(socket instanceof WebSocket);
    const echo = new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
    socket.send("ping");
    assert.equal(await echo, "ping");
    const [seen] = app.sockets;
    assert.equal(seen?.url, "/live?room=1");
    assert.equal(seen?.headers.host, `localhost:${app.port}`);
    assert.equal(seen?.headers.origin, `http://localhost:${app.port}`);
    assert.equal(seen?.headers.cookie, "theme=dark");

    assert.equal(await open({ origin: g.agentOrigin(alice), cookie: `${cookie(g.tokens.alice)}; ${chosen}` }), 403, "another origin");
    assert.equal(await open({ origin, cookie: chosen }), 401, "signed out");
    assert.equal(await open({ origin, cookie: cookie(g.tokens.alice) }), 404, "no app chosen");

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    assert.equal(g.connections.closeSession(hashSessionToken(g.tokens.alice), 4001, "signed out"), 1);
    await closed;
  }));
