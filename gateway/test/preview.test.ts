// The preview ports (preview-proxy.ts): the person's browser reaching a web app that runs in their workspace, on
// the agent port + PREVIEW_PORT_OFFSET. The same checks as the agent ports, a chosen app port per preview port, the
// app seeing a local browser and none of the portal's cookies, and responses that can't escape the preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { hashSessionToken } from "@portal/core";
import { cookie, json, request, startGateway, type Gateway, type Reply } from "./harness.ts";
import { previewCookieName } from "../src/proxy/preview-proxy.ts";

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

const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site", accept: "text/html" };

function previewNavigate(g: Gateway, token: string | null, userId: number, path: string, extra: Record<string, string> = {}, kind: "private" | "online" = "private"): Promise<Reply> {
  const headers: Record<string, string> = { ...NAVIGATE, ...extra };
  if (token) headers.cookie = [cookie(token), extra.cookie].filter(Boolean).join("; ");
  return request(g.previewPort(userId, kind), { path, headers });
}

/** Chooses `port` on the user's preview port; returns the cookie pair the browser keeps. */
async function choose(g: Gateway, token: string, userId: number, port: number | string, kind: "private" | "online" = "private"): Promise<string> {
  const reply = await previewNavigate(g, token, userId, `/__portal/port/${port}/`, {}, kind);
  assert.equal(reply.status, 303, reply.body);
  return String(reply.headers["set-cookie"]?.[0]).split(";")[0]!;
}

async function withApp(run: (g: Gateway, app: Awaited<ReturnType<typeof startApp>>, alice: number) => Promise<void>): Promise<void> {
  const g = await startGateway();
  const alice = g.ids.alice;
  await g.startReady(alice);
  const app = await startApp(g.manager.upstream(alice, "private")!.host);
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
    const agentPort = g.manager.upstream(alice, "private")!.port;
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

test("the app's answer: no portal cookies, framed only by its Web Shell inside the portal, redirects kept on the preview", () =>
  withApp(async (g, app, alice) => {
    const chosen = await choose(g, g.tokens.alice, alice, app.port);
    const page = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<h1>the game</h1>");
    assert.deepEqual(page.headers["set-cookie"], ["app=1; Path=/"]);
    assert.equal(page.headers["x-frame-options"], undefined);
    assert.equal(page.headers["cache-control"], "private, no-store");
    const host = "127.0.0.1";
    const ancestors = `frame-ancestors http://${host}:${g.config.webPort} https://${host}:${g.config.webPort} http://${host}:${g.agentPort(alice)} https://${host}:${g.agentPort(alice)}`;
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
    await g.startReady(alice, undefined, "online");
    const app = await startApp(g.manager.upstream(alice, "online")!.host);
    try {
      const chosen = await choose(g, g.tokens.alice, alice, app.port, "online");
      const page = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen }, "online");
      assert.equal(page.status, 200);
      assert.equal(String(page.headers["content-security-policy"]).split(", ").length, 1);
      // Her Private preview port doesn't reach the Online workspace (its own cookie, too, is the Online port's).
      const other = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
      assert.equal(other.status, 409);
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
    assert.match(unchosen.body, /No app chosen/);
    const xhr = await request(g.previewPort(alice), { path: "/api", headers: { cookie: cookie(g.tokens.alice), "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } });
    assert.equal(json<{ error: string }>(xhr).error, "no_app_chosen");

    const port = app.port;
    await app.close();
    const chosen = await choose(g, g.tokens.alice, alice, port);
    const down = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
    assert.equal(down.status, 502);
    assert.match(down.body, new RegExp(`Nothing answers on port ${port}`));
    assert.match(String(down.headers["content-security-policy"]), new RegExp(`frame-ancestors .*:${g.agentPort(alice)}`), "framed in the Web preview");

    await g.manager.stop(alice, "test");
    const stopped = await previewNavigate(g, g.tokens.alice, alice, "/", { cookie: chosen });
    assert.equal(stopped.status, 503);
    assert.match(stopped.body, /workspace is stopped/);
  }));

test("WebSockets reach the chosen app as a local browser's, after the same checks, and close with the session", () =>
  withApp(async (g, app, alice) => {
    const chosen = await choose(g, g.tokens.alice, alice, app.port);
    const origin = `http://127.0.0.1:${g.previewPort(alice)}`;
    const open = (headers: Record<string, string>): Promise<WebSocket | number> =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${g.previewPort(alice)}/live?room=1`, { headers });
        socket.once("open", () => resolve(socket));
        socket.once("unexpected-response", (_req, res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        socket.once("error", () => undefined);
      });
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
