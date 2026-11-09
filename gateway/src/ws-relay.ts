// WebSocket relay for the agents' sockets (the driver's socketPaths). Both sides are terminated:
// the gateway connects to the workspace first and accepts the browser only once the workspace has
// accepted, so its answer (401/403/…) can be passed back as a plain HTTP status.
// The driver puts the container's credential on the upstream handshake. For a token agent the
// browser must present its session-bound token: browsers can't set headers on WebSockets, so the
// UI offers it as a `qwen-bearer.<base64url>` subprotocol, which is checked and not passed on.
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { tokensEqual, type SessionContext } from "@portal/db";
import { checkAgentAccess, INVALID_TOKEN, unavailableError, type AgentDeps } from "./agent-access.ts";
import { driverFor } from "./agents/index.ts";
import { MIB } from "./config.ts";
import { connectionRole } from "./connections.ts";
import { bearerToken, splitBearerSubprotocol } from "./headers.ts";
import { splitTarget } from "./http-util.ts";
import type { Upstream } from "./workspaces.ts";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const MAX_MISSED_PONGS = 2;
/** Pause the sending side while more than this is waiting to be written to the other side. */
const HIGH_WATER_BYTES = 4 * MIB;
const LOW_WATER_BYTES = MIB;

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** The subprotocol the workspace selected, per handshake, for the browser side's answer. */
const selectedProtocol = new WeakMap<IncomingMessage, string>();

export function createWsRelay(deps: AgentDeps): UpgradeHandler {
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    clientTracking: false,
    handleProtocols: (_offered, request) => selectedProtocol.get(request) ?? false,
  });
  return (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!isWebSocketHandshake(req)) return rejectUpgrade(socket, 400, "bad_request");
    const access = checkAgentAccess(req, deps, true);
    if (!access.ok) return rejectUpgrade(socket, access.status, access.code, access.message);
    // As on the HTTP side, a token the browser presents must be the right one, whatever the agent.
    const { token: offered, protocols } = splitBearerSubprotocol(req.headers["sec-websocket-protocol"]);
    const presented = presentedToken(offered, req.headers.authorization);
    if (presented !== null && !tokensEqual(presented, access.browserToken)) {
      return rejectUpgrade(socket, 401, INVALID_TOKEN.code, INVALID_TOKEN.message);
    }
    const upstream = deps.manager.upstream(access.userId);
    if (!upstream) {
      // Like the HTTP side: never starts the workspace, so a reconnect loop can't wake it.
      const { code, message, headers } = unavailableError(deps.manager.info(access.userId).status);
      return rejectUpgrade(socket, 503, code, message, headers);
    }
    const driver = driverFor(upstream.agent);
    if (!driver.socketPaths.has(splitTarget(req.url ?? "").pathname)) return rejectUpgrade(socket, 404, "not_found");
    // A token agent's sockets need the token.
    if (driver.browserAuth === "token" && presented === null) return rejectUpgrade(socket, 401, INVALID_TOKEN.code, INVALID_TOKEN.message);
    connect(deps, server, req, socket, head, upstream, access.context, access.userId, protocols);
  };
}

function connect(
  deps: AgentDeps,
  server: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstream: Upstream,
  context: SessionContext,
  userId: number,
  protocols: string[],
): void {
  const workspace = new WebSocket(`ws://${upstream.host}:${upstream.port}${req.url ?? "/"}`, protocols, {
    headers: driverFor(upstream.agent).requestHeaders(req.headers, upstream, { authorised: true, websocket: true }),
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
  });
  // The workspace may speak first; its messages wait here until the browser side is accepted.
  const fromWorkspace = relayMessages(workspace, null);

  let settled = false;
  let attached = false;
  const fail = (status: number, code: string): void => {
    if (settled) return;
    settled = true;
    workspace.terminate();
    rejectUpgrade(socket, status, code);
  };
  socket.once("close", () => {
    if (!attached) workspace.terminate();
  });
  workspace.once("unexpected-response", (_request, response) => {
    response.resume();
    const status = response.statusCode === 401 || response.statusCode === 403 ? response.statusCode : 502;
    deps.log.warn("the workspace refused the socket", { userId, status: response.statusCode });
    fail(status, status === 502 ? "workspace_unreachable" : "workspace_refused");
  });
  workspace.on("error", (error) => {
    if (settled) return;
    deps.log.warn("could not open the agent socket", { userId, error });
    deps.manager.checkContainer(userId);
    fail(502, "workspace_unreachable");
  });
  workspace.once("open", () => {
    if (settled) return;
    settled = true;
    if (workspace.protocol) selectedProtocol.set(req, workspace.protocol);
    server.handleUpgrade(req, socket, head, (browser) => {
      attached = true;
      bridge(deps, browser, workspace, fromWorkspace, context, userId);
    });
  });
}

function bridge(deps: AgentDeps, browser: WebSocket, workspace: WebSocket, fromWorkspace: MessageRelay, context: SessionContext, userId: number): void {
  fromWorkspace.attach(browser);
  // Typing in the terminal (or any message the browser sends) is someone using the workspace.
  relayMessages(browser, () => deps.manager.touch(userId)).attach(workspace);

  const unregister = deps.connections.add({
    userId,
    sessionId: context.session.id,
    role: connectionRole(context),
    close: (code, reason) => browser.close(code, reason),
  });

  // The gateway keeps the browser side honest with pings of its own.
  let missedPongs = 0;
  const heartbeat = setInterval(() => {
    if (missedPongs >= MAX_MISSED_PONGS) {
      browser.terminate();
      return;
    }
    missedPongs++;
    browser.ping();
  }, PING_INTERVAL_MS);
  browser.on("pong", () => {
    missedPongs = 0;
  });

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unregister();
  };
  browser.on("close", (code, reason) => {
    cleanup();
    closePeer(workspace, code, reason);
  });
  workspace.on("close", (code, reason) => {
    cleanup();
    closePeer(browser, code, reason);
  });
  browser.on("error", (error) => deps.log.warn("agent socket error (browser side)", { userId, error }));
}

interface MessageRelay {
  attach(target: WebSocket): void;
}

/**
 * Forwards data messages from `source`, keeping text and binary frames as they are. Messages
 * arriving before a target is attached are held. Applies backpressure by pausing `source`.
 */
function relayMessages(source: WebSocket, onMessage: (() => void) | null): MessageRelay {
  let target: WebSocket | null = null;
  const early: Array<{ data: Buffer; binary: boolean }> = [];
  let unwritten = 0;

  const send = (data: Buffer, binary: boolean): void => {
    if (target?.readyState !== WebSocket.OPEN) return;
    unwritten += data.length;
    target.send(data, { binary }, () => {
      unwritten -= data.length;
      if (unwritten <= LOW_WATER_BYTES && source.isPaused) source.resume();
    });
    if (unwritten > HIGH_WATER_BYTES && !source.isPaused) source.pause();
  };

  source.on("message", (raw, binary) => {
    onMessage?.();
    const data = toBuffer(raw);
    if (target) send(data, binary);
    else early.push({ data, binary });
  });

  return {
    attach(next) {
      target = next;
      for (const message of early.splice(0)) send(message.data, message.binary);
    },
  };
}

function closePeer(peer: WebSocket, code: number, reason: Buffer): void {
  if (peer.readyState === WebSocket.OPEN) peer.close(relayCloseCode(code), reason);
  else if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
}

/** A close code that may be sent on: 1005 (none given) becomes 1000, other unsendable codes 1011. */
export function relayCloseCode(code: number): number {
  if (code === 1005) return 1000;
  const sendable = (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1006) || (code >= 3000 && code <= 4999);
  return sendable ? code : 1011;
}

/** The token a browser presents: the bearer subprotocol, else an Authorization header ("" when malformed); null if none. */
function presentedToken(offered: string | null, authorization: string | undefined): string | null {
  if (offered !== null) return offered;
  if (authorization === undefined) return null;
  return bearerToken(authorization) ?? "";
}

function isWebSocketHandshake(req: IncomingMessage): boolean {
  const { headers } = req;
  return (
    req.method === "GET" &&
    headers.upgrade?.toLowerCase() === "websocket" &&
    headers["sec-websocket-version"] === "13" &&
    /^[+/0-9A-Za-z]{22}==$/.test(headers["sec-websocket-key"] ?? "")
  );
}

/** Answers a refused handshake with the gateway's usual JSON error. */
function rejectUpgrade(socket: Duplex, status: number, code: string, message?: string, headers: Record<string, string> = {}): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const reason = STATUS_CODES[status] ?? "Error";
  const body = JSON.stringify({ error: code, message: message ?? reason });
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n${extra}` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
