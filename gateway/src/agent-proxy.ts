// The agent ports: every browser request for a workspace. One port per user (AGENT_PORT_BASE + id),
// so each workspace is its own browser origin. It checks the portal session, starts a stopped
// workspace on document navigations only, and streams everything else to that user's
// `qwen serve`, swapping the browser's session-bound token for the container's real one.
// WebSocket upgrades go to ws-relay.ts.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { tokensEqual } from "@portal/db";
import { checkAgentAccess, type AgentDeps } from "./agent-access.ts";
import type { AgentConnection } from "./connections.ts";
import { forward, PayloadTooLargeError } from "./forward.ts";
import { bearerToken, frameAncestorSources, qwenRequestHeaders, qwenResponseHeaders, type FramePolicy, type HostParts } from "./headers.ts";
import { isDocumentNavigation, sendError, splitTarget } from "./http-util.ts";
import {
  PORTAL_PATH_PREFIX,
  START_PATH,
  capacityPage,
  errorPage,
  otherWorkspacePage,
  signedOutPage,
  startingPage,
  stoppedPage,
  unreachablePage,
} from "./pages.ts";
import { createWsRelay } from "./ws-relay.ts";

const MIB = 1024 * 1024;
/**
 * Web Shell endpoints that are not available through the portal: device pairing would hand the
 * container's real token to a browser.
 */
const BLOCKED_PREFIXES = ["/web-shell/pairing"];

/**
 * The path as a lenient router might see it: percent-decoded, backslashes and repeated slashes
 * folded, dot segments resolved, lower-cased. Used only to refuse blocked paths in any spelling.
 */
export function canonicalPath(pathname: string): string {
  let path = pathname;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  try {
    path = new URL(path.startsWith("/") ? path : `/${path}`, "http://canonical.invalid").pathname;
  } catch {
    // keep the folded form
  }
  return path.toLowerCase();
}

export function isBlockedPath(pathname: string): boolean {
  const path = canonicalPath(pathname);
  return BLOCKED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Returns a function that creates one agent server; main.ts listens with one per workspace port. */
export function createAgentServerFactory(deps: AgentDeps): () => http.Server {
  const onUpgrade = createWsRelay(deps);
  return () => {
    // No request timeout: uploads may take long, and responses (event streams) are open-ended.
    const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
      handleRequest(deps, req, res).catch((error: unknown) => {
        deps.log.error("agent request failed", { error });
        if (!res.headersSent) sendError(res, 500, "internal", "Internal error.");
        else res.destroy();
      });
    });
    server.on("upgrade", onUpgrade);
    return server;
  };
}

/**
 * Requests that mean a person is using the workspace. The Web Shell polls several endpoints and
 * sends heartbeats while a tab is merely open, so reads and heartbeats don't count.
 */
export function isUserAction(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !pathname.endsWith("/heartbeat");
}

async function handleRequest(deps: AgentDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const target = req.url ?? "";
  if (!target.startsWith("/")) return sendError(res, 400, "bad_request", "Unsupported request target.");

  const navigation = isDocumentNavigation(method, req.headers);
  const access = checkAgentAccess(req, deps, false);
  if (!access.ok) {
    if (navigation && access.host) {
      const portal = `//${access.host.hostname}:${deps.config.webPort}`;
      if (access.status === 401) return sendPage(res, 401, signedOutPage(`${portal}/login`), framing(deps, access.host));
      if (access.code === "other_workspace") return sendPage(res, 403, otherWorkspacePage(`${portal}/`), framing(deps, access.host));
    }
    return sendError(res, access.status, access.code, access.message);
  }

  const { host, context, userId } = access;
  const { pathname } = splitTarget(target);
  if (pathname.startsWith(PORTAL_PATH_PREFIX)) return handlePortalPath(deps, req, res, userId, host, pathname);
  if (isBlockedPath(pathname)) {
    return sendError(res, 403, "not_available", "This feature is not available in the portal.");
  }

  // The Web Shell authenticates with a bearer token. Only this session's token for this workspace
  // unlocks the container; requests without one (the page and its static assets) go through
  // unauthenticated, and the workspace answers anything else with 401 itself.
  let serverToken: string | null = null;
  if (req.headers.authorization !== undefined) {
    const presented = bearerToken(req.headers.authorization);
    if (presented === null || !tokensEqual(presented, access.browserToken)) {
      return sendError(res, 401, "Unauthorized", "Reload the portal page to reconnect to your workspace.");
    }
    serverToken = "";
  }

  const upstream = deps.manager.upstream(userId);
  if (!upstream) return handleUnavailable(deps, res, userId, host, navigation, req.headers["sec-fetch-site"] === "cross-site");
  if (serverToken !== null) serverToken = upstream.token;
  // An open Web Shell tab polls every few seconds: this session has the workspace open.
  deps.connections.seen(userId, context.session.id, context.actingAs ? "admin" : "owner");

  if (navigation || isUserAction(method, pathname)) deps.manager.touch(userId);

  const limit = deps.config.uploadLimitBytes;
  const tooLarge = (response: ServerResponse): void =>
    sendError(response, 413, "payload_too_large", `Uploads are limited to ${limit / MIB} MB.`, { connection: "close" });
  if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(res);

  await forward(req, res, {
    url: new URL(`http://${upstream.host}:${upstream.port}${target}`),
    method,
    headers: qwenRequestHeaders(req.headers, `${upstream.host}:${upstream.port}`, serverToken),
    bodyLimit: limit,
    responseHeaders: (incoming) => {
      // An event stream is an open tab watching a session: report it, and close it with the session.
      if (String(incoming.headers["content-type"] ?? "").startsWith("text/event-stream")) trackStream(deps, res, userId, context);
      return qwenResponseHeaders(incoming.headers, framing(deps, host), incoming.statusCode);
    },
    onError: (error, response) => {
      if (error instanceof PayloadTooLargeError) return tooLarge(response);
      deps.log.warn("workspace did not answer", { userId, error });
      deps.manager.checkContainer(userId);
      if (navigation) sendPage(response, 502, unreachablePage(), framing(deps, host));
      else sendError(response, 502, "workspace_unreachable", "The workspace did not answer.");
    },
  });
}

function trackStream(deps: AgentDeps, res: ServerResponse, userId: number, context: AgentAccessContext): void {
  const connection: AgentConnection = {
    userId,
    sessionId: context.session.id,
    role: context.actingAs ? "admin" : "owner",
    close: () => res.destroy(),
  };
  const unregister = deps.connections.add(connection);
  res.once("close", unregister);
}

type AgentAccessContext = Extract<ReturnType<typeof checkAgentAccess>, { ok: true }>["context"];

/**
 * The workspace is not ready. Only a page load starts it; anything else just gets a 503. A page
 * load from another site (a link elsewhere) gets a Start button instead, so outside pages can't
 * boot workspaces.
 */
function handleUnavailable(
  deps: AgentDeps,
  res: ServerResponse,
  userId: number,
  host: HostParts,
  navigation: boolean,
  crossSite: boolean,
): void {
  const { status, lastError } = deps.manager.info(userId);
  const starting = status === "starting" || status === "running";
  if (!navigation) {
    if (starting) return sendError(res, 503, "workspace_starting", "The workspace is starting.", { "retry-after": "2" });
    if (status === "error") return sendError(res, 503, "workspace_error", "The workspace failed to start.");
    return sendError(res, 503, "workspace_stopped", "The workspace is not running.");
  }
  if (starting) return sendPage(res, 503, startingPage(), framing(deps, host), { "retry-after": "2" });
  if (status === "error") return sendPage(res, 503, errorPage("Something went wrong while it was starting.", lastError), framing(deps, host));
  if (crossSite) return sendPage(res, 503, stoppedPage(), framing(deps, host));
  startAndRespond(deps, res, userId, host, () => sendPage(res, 503, startingPage(), framing(deps, host), { "retry-after": "2" }));
}

/** Gateway-owned paths: the "Try again" form of the capacity and error pages. */
function handlePortalPath(
  deps: AgentDeps,
  req: IncomingMessage,
  res: ServerResponse,
  userId: number,
  host: HostParts,
  pathname: string,
): void {
  if (pathname !== START_PATH) return sendError(res, 404, "not_found", "Not found.");
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "Use POST.", { allow: "POST" });
  req.resume();
  startAndRespond(deps, res, userId, host, () => {
    res.writeHead(303, { location: "/", "cache-control": "no-store", "content-length": 0 });
    res.end();
  });
}

function startAndRespond(deps: AgentDeps, res: ServerResponse, userId: number, host: HostParts, onStarted: () => void): void {
  deps.manager.touch(userId);
  const attempt = deps.manager.requestStart(userId);
  if (!attempt.ok) return sendPage(res, 503, capacityPage(deps.config.maxRunning), framing(deps, host));
  // Failures are recorded on the workspace; the starting page's next reload shows them.
  attempt.done.catch(() => undefined);
  onStarted();
}

function framing(deps: AgentDeps, host: HostParts): FramePolicy {
  return { hostname: host.hostname, webPort: deps.config.webPort };
}

function sendPage(res: ServerResponse, status: number, html: string, frame: FramePolicy, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors ${frameAncestorSources(frame)}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(html);
}
