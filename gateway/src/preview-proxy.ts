// The preview ports: the web apps running in a workspace, as the person's browser sees them. A workspace runs on a
// host the browser can't reach (a Docker network), so `http://localhost:3000` in the Web Shell's Web preview, which
// loads in the person's own browser, would be the person's own computer. The Web preview (trim-web-shell.mjs) opens
// such an address here instead: one port per user and kind, the agent port + PREVIEW_PORT_OFFSET, so an app is a
// browser origin of its own, apart from the agent's (its page can't read the Web Shell's token or storage) and from
// every other workspace's.
//
// A request passes the agent ports' checks (agent-access.ts; a same-site page load may also open a preview in a tab
// of its own), then goes to the port of the workspace the person chose: `/__portal/port/<n>/<path>` keeps n in a
// cookie of this port and redirects to /<path>; everything after goes to n, WebSockets included. The app sees a
// browser on its own machine (Host and Origin localhost:<n>) and none of the portal's cookies; its responses may be
// framed only by this workspace's Web Shell inside the portal, and a Private workspace's app is confined to this
// origin (privatePreviewPolicy), as the workspace is to its host. Nothing here starts a workspace.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionContext } from "@portal/db";
import { checkAgentAccess, otherKindError, unavailableError, type AgentAccess, type AgentDeps } from "./agent-access.ts";
import { framing, handlePortalPath, handleUnavailable, sendPage, trackStream } from "./agent-proxy.ts";
import { MIB, PREVIEW_PORT_OFFSET } from "./config.ts";
import { connectionRole } from "./connections.ts";
import { forward, PayloadTooLargeError } from "./forward.ts";
import { endToEndHeaders, isPortalCookie, previewRequestHeaders, previewResponseHeaders, type FramePolicy, type HostParts } from "./headers.ts";
import { createStreamingServer, isDocumentNavigation, sendError, splitTarget } from "./http-util.ts";
import {
  otherWorkspacePage,
  PORT_PATH,
  PORTAL_PATH_PREFIX,
  previewBadPortPage,
  previewUnchosenPage,
  previewUnreachablePage,
  signedOutPage,
  START_PATH,
} from "./pages.ts";
import type { Upstream } from "./workspaces.ts";

const HANDSHAKE_TIMEOUT_MS = 15_000;
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

/** The app port this preview port's cookie names (the raw value; appPort validates it). */
function chosenPort(cookie: string | undefined, previewPort: number): string | undefined {
  const name = `${previewCookieName(previewPort)}=`;
  for (const pair of (cookie ?? "").split(";")) {
    const trimmed = pair.trim();
    if (trimmed.startsWith(name)) return trimmed.slice(name.length);
  }
  return undefined;
}

/** Returns a function that creates one preview server; main.ts listens with one per preview port. */
export function createPreviewServerFactory(deps: AgentDeps): () => http.Server {
  return () => {
    const server = createStreamingServer((req, res) => {
      handleRequest(deps, req, res).catch((error: unknown) => {
        deps.log.error("preview request failed", { error });
        if (!res.headersSent) sendError(res, 500, "internal", "Internal error.");
        else res.destroy();
      });
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => handleUpgrade(deps, req, socket, head));
    return server;
  };
}

/** Who may frame this preview's pages: the portal, and this workspace's Web Shell (its agent port) within it. */
function previewFraming(deps: AgentDeps, host: HostParts, previewPort: number): FramePolicy {
  return { ...framing(deps, host), agentPort: previewPort - PREVIEW_PORT_OFFSET };
}

/** The preview's origin as the browser uses it (the Host it sent). */
function originOf(host: HostParts, previewPort: number): string {
  return `http://${host.hostname}:${host.port ?? previewPort}`;
}

async function handleRequest(deps: AgentDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const target = req.url ?? "";
  if (!target.startsWith("/")) return sendError(res, 400, "bad_request", "Unsupported request target.");
  const previewPort = req.socket.localPort ?? 0;

  const navigation = isDocumentNavigation(method, req.headers);
  const access = checkAgentAccess(req, deps, false, "preview");
  if (!access.ok) return refuse(deps, res, access, navigation, previewPort);

  const { host, context, userId, kind } = access;
  const frame = previewFraming(deps, host, previewPort);
  const { pathname, search } = splitTarget(target);
  // Only this kind's container: while the other kind runs, nothing here reaches it.
  const upstream = deps.manager.upstream(userId, kind);

  if (pathname.startsWith(PORTAL_PATH_PREFIX)) {
    if (pathname === START_PATH) return handlePortalPath(deps, req, res, userId, kind, host, pathname);
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

  if (!upstream) return handleUnavailable(deps, res, userId, kind, host, navigation, frame);
  const port = appPort(chosenPort(req.headers.cookie, previewPort), upstream);
  if (port === null) {
    if (navigation) return sendPage(res, 404, previewUnchosenPage(), frame);
    return sendError(res, 404, "no_app_chosen", "No app chosen: open it from the Web preview.");
  }

  deps.connections.seen(userId, context.session.id, connectionRole(context));
  if (navigation) deps.manager.touch(userId);

  const limit = deps.config.uploadLimitBytes;
  const tooLarge = (response: ServerResponse): void =>
    sendError(response, 413, "payload_too_large", `Uploads are limited to ${limit / MIB} MB.`, { connection: "close" });
  if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(res);

  const origin = originOf(host, previewPort);
  await forward(req, res, {
    url: new URL(`http://${upstream.host}:${port}${target}`),
    method,
    headers: previewRequestHeaders(req.headers, origin, port),
    bodyLimit: limit,
    responseHeaders: (incoming) => {
      if (String(incoming.headers["content-type"] ?? "").startsWith("text/event-stream")) trackStream(deps, res, userId, context);
      return previewResponseHeaders(incoming.headers, { frame, port, privateOrigin: kind === "private" ? origin : null }, incoming.statusCode);
    },
    onError: (error, response) => {
      if (error instanceof PayloadTooLargeError) return tooLarge(response);
      if (navigation) sendPage(response, 502, previewUnreachablePage(port), frame);
      else sendError(response, 502, "app_unreachable", `Nothing in the workspace answers on port ${port}.`);
    },
  });
}

/** A refused request: signed out or another workspace get a page when it is a page load; the rest their JSON error. */
function refuse(deps: AgentDeps, res: ServerResponse, access: Extract<AgentAccess, { ok: false }>, navigation: boolean, previewPort: number): void {
  if (navigation && access.host) {
    const portal = `//${access.host.hostname}:${deps.config.webPort}`;
    const frame = previewFraming(deps, access.host, previewPort);
    if (access.status === 401) return sendPage(res, 401, signedOutPage(`${portal}/login`), frame);
    if (access.code === "other_workspace") return sendPage(res, 403, otherWorkspacePage(`${portal}/`), frame);
  }
  sendError(res, access.status, access.code, access.message);
}

/**
 * A WebSocket (or other upgrade) to the chosen app: after the same checks, the handshake goes to the app with the
 * preview's request headers and its answer comes back (without portal cookies); then the two connections are joined
 * byte for byte. The socket closes with the workspace, the session or its disconnect. Data the browser sends on it
 * is someone using the workspace (a game, a live page), as on the agent's sockets.
 */
function handleUpgrade(deps: AgentDeps, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on("error", () => socket.destroy());
  const previewPort = req.socket.localPort ?? 0;
  if (req.method !== "GET") return rejectUpgrade(socket, 400, "bad_request");
  const access = checkAgentAccess(req, deps, true, "preview");
  if (!access.ok) return rejectUpgrade(socket, access.status, access.code, access.message);
  const { host, context, userId, kind } = access;
  const upstream = deps.manager.upstream(userId, kind);
  if (!upstream) {
    const info = deps.manager.info(userId);
    const other = otherKindError(info, kind);
    if (other) return rejectUpgrade(socket, 409, other.code, other.message);
    const { code, message } = unavailableError(info.kind === kind ? info.status : "stopped");
    return rejectUpgrade(socket, 503, code, message);
  }
  const port = appPort(chosenPort(req.headers.cookie, previewPort), upstream);
  if (port === null) return rejectUpgrade(socket, 404, "no_app_chosen");

  const headers = previewRequestHeaders(req.headers, originOf(host, previewPort), port);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade ?? "websocket";
  const request = http.request({
    host: upstream.host,
    port,
    method: "GET",
    path: req.url ?? "/",
    headers,
    agent: false,
  });
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
    join(deps, socket, app, context, userId);
  });
  request.end();
}

function join(deps: AgentDeps, browser: Duplex, app: Duplex, context: SessionContext, userId: number): void {
  const unregister = deps.connections.add({
    userId,
    sessionId: context.session.id,
    role: connectionRole(context),
    close: () => {
      browser.destroy();
      app.destroy();
    },
  });
  // Someone using the app; at most once a second is plenty for the idle clock.
  let lastTouch = 0;
  browser.on("data", () => {
    const now = Date.now();
    if (now - lastTouch < 1_000) return;
    lastTouch = now;
    deps.manager.touch(userId);
  });
  app.on("error", () => browser.destroy());
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    unregister();
    browser.destroy();
    app.destroy();
  };
  browser.once("close", close);
  app.once("close", close);
  browser.pipe(app);
  app.pipe(browser);
}

/** Answers a refused handshake with the gateway's usual JSON error. */
function rejectUpgrade(socket: Duplex, status: number, code: string, message?: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const reason = http.STATUS_CODES[status] ?? "Error";
  const body = JSON.stringify({ error: code, message: message ?? reason });
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
