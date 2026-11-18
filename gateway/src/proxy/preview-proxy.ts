// The preview ports: the web apps running in a workspace, as the person's browser sees them. A workspace runs on a
// host the browser can't reach, so the Web Shell's Web preview (trim-web-shell.mjs) opens `http://localhost:<n>` here
// instead: one port per user and kind, the agent port + PREVIEW_PORT_OFFSET, so an app is a browser origin of its
// own, apart from the agent's (its page can't read the Web Shell's token or storage) and every other workspace's.
//
// A request passes the agent ports' checks, then goes to the port of the workspace the person chose:
// `/__portal/port/<n>/<path>` keeps n in a cookie of this port and redirects to /<path>; everything after goes to n,
// WebSockets included. The app sees a browser on its own machine and none of the portal's cookies; a Private
// workspace's app is confined to this origin, as the workspace is to its host. Nothing here starts a workspace.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { checkAgentAccess, unavailable, type AgentDeps } from "./agent-access.ts";
import { admit, handlePortalPath, handleUnavailable, relay, sendPage } from "./agent-proxy.ts";
import { connectionOf } from "./connections.ts";
import { endToEndHeaders, isPortalCookie, previewRequestHeaders, previewResponseHeaders, type HostParts } from "./headers.ts";
import { createStreamingServer, sendError, splitTarget } from "../lib/http-util.ts";
import { PORT_PATH, PORTAL_PATH_PREFIX, previewBadPortPage, previewUnchosenPage, previewUnreachablePage, START_PATH } from "./pages.ts";
import { HANDSHAKE_TIMEOUT_MS, rejectUpgrade } from "./ws-relay.ts";
import type { Upstream } from "../workspaces/manager.ts";

/** Ports below this need root in the container, where nothing runs as root. */
const FIRST_PORT = 1024;

/** The cookie that keeps a preview port's chosen app port; named after the preview port, as cookies ignore ports. */
export function previewCookieName(previewPort: number): string {
  return `portal_preview_${previewPort}`;
}

/** A port a workspace's app may be served from, or null: 1024-65535, never the agent's own (the driver's port). */
function appPort(text: string | undefined, upstream: Upstream | null): number | null {
  if (text === undefined || !/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  if (port < FIRST_PORT || port > 65535) return null;
  return upstream !== null && port === upstream.port ? null : port;
}

/** The app port this preview port's cookie names, if it is one the app may be served from. */
function chosenPort(req: IncomingMessage, upstream: Upstream): number | null {
  const name = `${previewCookieName(req.socket.localPort ?? 0)}=`;
  const pair = (req.headers.cookie ?? "").split(";").find((candidate) => candidate.trim().startsWith(name));
  return appPort(pair?.trim().slice(name.length), upstream);
}

/** Returns a function that creates one preview server; main.ts listens with one per preview port. */
export function createPreviewServerFactory(deps: AgentDeps): () => http.Server {
  return () =>
    createStreamingServer(deps.log, "preview", (req, res) => handleRequest(deps, req, res)).on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      handleUpgrade(deps, req, socket, head),
    );
}

/** The preview's origin as the browser names it (the Host it sent). */
function originOf(deps: AgentDeps, host: HostParts, previewPort: number): string {
  return `${deps.config.scheme}://${host.hostname}:${host.port ?? previewPort}`;
}

async function handleRequest(deps: AgentDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admitted = admit(deps, req, res, "preview");
  if (!admitted) return;
  const { method, target, navigation, frame, host, userId, kind } = admitted;
  const previewPort = req.socket.localPort ?? 0;
  const { pathname, search } = splitTarget(target);
  // Only this kind's container: while the other kind runs, nothing here reaches it.
  const upstream = deps.manager.upstream(userId, kind);

  if (pathname.startsWith(PORTAL_PATH_PREFIX)) {
    // "Try again" as on the agent port, its pages framed by the portal alone.
    if (pathname === START_PATH) return handlePortalPath(deps, req, res, userId, kind, { portal: frame.portal }, pathname);
    if (!pathname.startsWith(PORT_PATH)) return sendError(res, 404, "not_found", "Not found.");
    if (method !== "GET" && method !== "HEAD") return sendError(res, 405, "method_not_allowed", "Use GET.", { allow: "GET, HEAD" });
    // /__portal/port/<n>[/<path>]: serve n from now on, from /<path>.
    const rest = pathname.slice(PORT_PATH.length);
    const slash = rest.indexOf("/");
    const asked = slash === -1 ? rest : rest.slice(0, slash);
    const port = appPort(asked, upstream);
    if (port === null) {
      if (navigation) return sendPage(res, 400, previewBadPortPage(asked.slice(0, 12)), frame);
      return sendError(res, 400, "bad_port", `Choose a port from ${FIRST_PORT} to 65535, other than the agent's.`);
    }
    const path = slash === -1 ? "/" : rest.slice(slash);
    res.writeHead(303, {
      // Only a path of this origin: `//x` or `/\x` would leave it.
      location: `${/^\/(?![/\\])/.test(path) ? path : "/"}${search}`,
      "set-cookie": `${previewCookieName(previewPort)}=${port}; Path=/; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
      "content-length": 0,
    });
    res.end();
    return;
  }

  if (!upstream) return handleUnavailable(deps, res, userId, kind, navigation, frame);
  const port = chosenPort(req, upstream);
  if (port === null) {
    if (navigation) return sendPage(res, 404, previewUnchosenPage(), frame);
    return sendError(res, 404, "no_app_chosen", "No app chosen: open it from the Web preview.");
  }

  if (navigation) deps.manager.touch(userId);
  const origin = originOf(deps, host, previewPort);
  await relay(deps, req, res, admitted, {
    url: new URL(`http://${upstream.host}:${port}${target}`),
    headers: previewRequestHeaders(req.headers, origin, port),
    responseHeaders: (incoming) => previewResponseHeaders(incoming.headers, { frame, port, privateOrigin: kind === "private" ? origin : null }, incoming.statusCode),
    unreachable: () => ({ page: previewUnreachablePage(port), code: "app_unreachable", message: `Nothing in the workspace answers on port ${port}.` }),
  });
}

/**
 * A WebSocket (or other upgrade) to the chosen app: after the same checks, the handshake goes to the app with the
 * preview's request headers and its answer comes back (without portal cookies); then the two connections are joined
 * byte for byte. The socket closes with the workspace, the session or its disconnect.
 */
function handleUpgrade(deps: AgentDeps, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on("error", () => socket.destroy());
  if (req.method !== "GET") return rejectUpgrade(socket, 400, "bad_request");
  const access = checkAgentAccess(req, deps, true, "preview");
  if (!access.ok) return rejectUpgrade(socket, access.status, access.code, access.message);
  const { host, context, userId, kind } = access;
  const upstream = deps.manager.upstream(userId, kind);
  if (!upstream) {
    const no = unavailable(deps.manager.info(userId), kind);
    return rejectUpgrade(socket, no.status, no.code, no.message);
  }
  const port = chosenPort(req, upstream);
  if (port === null) return rejectUpgrade(socket, 404, "no_app_chosen");

  const headers = previewRequestHeaders(req.headers, originOf(deps, host, req.socket.localPort ?? 0), port);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade ?? "websocket";
  const request = http.request({ host: upstream.host, port, method: "GET", path: req.url ?? "/", headers, agent: false });
  let answered = false;
  // Only the handshake has a deadline: an open socket may stay quiet for as long as the app likes.
  const deadline = setTimeout(() => request.destroy(new Error("handshake timed out")), HANDSHAKE_TIMEOUT_MS);
  const settle = (): void => {
    answered = true;
    clearTimeout(deadline);
  };
  socket.once("close", () => {
    if (!answered) {
      clearTimeout(deadline);
      request.destroy();
    }
  });
  request.once("error", () => {
    if (answered) return;
    settle();
    rejectUpgrade(socket, 502, "app_unreachable", `Nothing in the workspace answers on port ${port}.`);
  });
  request.once("response", (response) => {
    settle();
    response.resume();
    rejectUpgrade(socket, response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404 ? response.statusCode : 502, "app_refused");
  });
  request.once("upgrade", (response, app, appHead) => {
    settle();
    if (!socket.writable) {
      app.destroy();
      return;
    }
    const answer = endToEndHeaders(response.headers);
    const cookies = (response.headers["set-cookie"] ?? []).filter((value) => !isPortalCookie(value));
    delete answer["set-cookie"];
    if (cookies.length > 0) answer["set-cookie"] = cookies;
    const lines = Object.entries(answer).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((one) => `${name}: ${one}`));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: ${response.headers.upgrade ?? "websocket"}\r\n${lines.map((line) => `${line}\r\n`).join("")}\r\n`);
    if (appHead.length > 0) socket.write(appHead);
    if (head.length > 0) app.write(head);

    const close = (): void => {
      socket.destroy();
      app.destroy();
    };
    const unregister = deps.connections.add(connectionOf(userId, context, close));
    // Data the browser sends is someone using the app; at most once a second is plenty for the idle clock.
    let lastTouch = 0;
    socket.on("data", () => {
      const now = Date.now();
      if (now - lastTouch < 1_000) return;
      lastTouch = now;
      deps.manager.touch(userId);
    });
    app.on("error", () => socket.destroy());
    for (const side of [socket, app]) {
      side.once("close", () => {
        unregister();
        close();
      });
    }
    socket.pipe(app);
    app.pipe(socket);
  });
  request.end();
}
