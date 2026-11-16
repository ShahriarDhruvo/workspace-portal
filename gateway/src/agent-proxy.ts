// The agent ports: every browser request for a workspace. One port per user and kind (Private: AGENT_PORT_BASE +
// id, Online: ONLINE_AGENT_PORT_BASE + id), so each workspace, and each of a user's two kinds, is its own browser
// origin. It checks the portal session and streams requests to that user's agent when the port's kind is the one
// running, with the container's credential added by the agent's driver (for token agents only when the browser
// presented its session-bound token of this kind). It never starts a workspace by itself: a stopped one is
// started from the portal, where the kind is chosen; only "Try again" (a POST) starts this port's kind after a
// failure or at the cap. WebSocket upgrades go to ws-relay.ts.
import type http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokensEqual, type SessionContext } from "@portal/db";
import type { WorkspaceKind } from "@portal/db";
import { checkAgentAccess, INVALID_TOKEN, otherKindError, unavailableError, type AgentDeps } from "./agent-access.ts";
import { driverFor, type AgentDriver } from "./agents/index.ts";
import { MIB } from "./config.ts";
import { connectionRole } from "./connections.ts";
import { forward, PayloadTooLargeError } from "./forward.ts";
import { bearerToken, frameAncestorSources, workspaceResponseHeaders, type FramePolicy, type HostParts } from "./headers.ts";
import { createStreamingServer, isDocumentNavigation, sendError, splitTarget } from "./http-util.ts";
import {
  PORTAL_PATH_PREFIX,
  START_PATH,
  capacityPage,
  errorPage,
  otherKindPage,
  otherWorkspacePage,
  refusedPage,
  signedOutPage,
  startingPage,
  stoppedPage,
  unreachablePage,
} from "./pages.ts";
import { createWsRelay } from "./ws-relay.ts";
import { CapacityError, KindMismatchError, OnlineDisabledError, OnlineNotAllowedError, type StartRefusal } from "./workspaces.ts";

/**
 * The path as a lenient router might see it: percent-decoded, backslashes and repeated slashes
 * folded, dot segments resolved, lower-cased. Used only to refuse blocked paths in any spelling.
 */
function canonicalPath(pathname: string): string {
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

/** The agent's features the portal refuses (see AgentDriver.blockedPrefixes), in any spelling. */
export function isBlockedPath(driver: AgentDriver, pathname: string): boolean {
  const path = canonicalPath(pathname);
  return driver.blockedPrefixes.some((prefix) => path.startsWith(prefix));
}

/** Returns a function that creates one agent server; main.ts listens with one per workspace port. */
export function createAgentServerFactory(deps: AgentDeps): () => http.Server {
  const onUpgrade = createWsRelay(deps);
  return () => {
    // Uploads may take long, and responses (event streams) are open-ended.
    const server = createStreamingServer((req, res) => {
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

  const { host, context, userId, kind } = access;
  const { pathname } = splitTarget(target);
  if (pathname.startsWith(PORTAL_PATH_PREFIX)) return handlePortalPath(deps, req, res, userId, kind, host, pathname);

  // Whatever the agent, a token the browser presents must be this session's token for this workspace and kind.
  const presentsToken = req.headers.authorization !== undefined;
  if (presentsToken) {
    const presented = bearerToken(req.headers.authorization);
    if (presented === null || !tokensEqual(presented, access.browserToken)) return sendError(res, 401, INVALID_TOKEN.code, INVALID_TOKEN.message);
  }

  // Only this kind's container: while the other kind runs, nothing here reaches it.
  const upstream = deps.manager.upstream(userId, kind);
  if (!upstream) return handleUnavailable(deps, res, userId, kind, host, navigation);
  const driver = driverFor(upstream.agent);
  if (isBlockedPath(driver, pathname)) {
    return sendError(res, 403, "not_available", "This feature is not available in the portal.");
  }

  // A token agent's UI authenticates with that token: only requests that presented it get the
  // container's credential; the others (the page and its static assets) go through unauthorised,
  // and the agent answers anything else with 401 itself. A cookie agent gets the credential on
  // every request: the session and port checks above authorise it.
  const authorised = driver.browserAuth === "cookie" || presentsToken;

  // An open agent tab polls every few seconds: this session has the workspace open.
  deps.connections.seen(userId, context.session.id, connectionRole(context));

  if (navigation || driver.isUserAction(method, pathname)) deps.manager.touch(userId);

  const limit = deps.config.uploadLimitBytes;
  const tooLarge = (response: ServerResponse): void =>
    sendError(response, 413, "payload_too_large", `Uploads are limited to ${limit / MIB} MB.`, { connection: "close" });
  if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(res);

  await forward(req, res, {
    url: new URL(`http://${upstream.host}:${upstream.port}${target}`),
    method,
    headers: driver.requestHeaders(req.headers, upstream, { authorised }),
    bodyLimit: limit,
    responseHeaders: (incoming) => {
      // An event stream is an open tab watching a session: report it, and close it with the session.
      if (String(incoming.headers["content-type"] ?? "").startsWith("text/event-stream")) trackStream(deps, res, userId, context);
      return workspaceResponseHeaders(incoming.headers, framing(deps, host), incoming.statusCode);
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

function trackStream(deps: AgentDeps, res: ServerResponse, userId: number, context: SessionContext): void {
  const unregister = deps.connections.add({
    userId,
    sessionId: context.session.id,
    role: connectionRole(context),
    close: () => res.destroy(),
  });
  res.once("close", unregister);
}

/**
 * This kind's workspace is not ready, and nothing here starts it (an open tab's reconnect loop must not wake a
 * stopped workspace, and the portal is where the kind is chosen). A page load gets a themed page: starting (it
 * reloads), the other kind running, the error with "Try again", or stopped with a link to the portal; anything
 * else gets the JSON error (409 for the other kind, else 503).
 */
function handleUnavailable(deps: AgentDeps, res: ServerResponse, userId: number, kind: WorkspaceKind, host: HostParts, navigation: boolean): void {
  const info = deps.manager.info(userId);
  const other = otherKindError(info, kind);
  const portal = `//${host.hostname}:${deps.config.webPort}/`;
  if (!navigation) {
    if (other) return sendError(res, 409, other.code, other.message);
    const { code, message, headers } = unavailableError(info.kind === kind ? info.status : "stopped");
    return sendError(res, 503, code, message, headers);
  }
  if (other) return sendPage(res, 409, otherKindPage(other.running, kind, portal), framing(deps, host));
  if (info.kind === kind && (info.status === "starting" || info.status === "running")) {
    return sendPage(res, 503, startingPage(kind), framing(deps, host), { "retry-after": "2" });
  }
  if (info.kind === kind && info.status === "error") {
    return sendPage(res, 503, errorPage("Something went wrong while it was starting.", info.lastError), framing(deps, host));
  }
  sendPage(res, 503, stoppedPage(kind, portal), framing(deps, host));
}

/** Gateway-owned paths: the "Try again" form of the capacity and error pages, for this port's kind. */
function handlePortalPath(
  deps: AgentDeps,
  req: IncomingMessage,
  res: ServerResponse,
  userId: number,
  kind: WorkspaceKind,
  host: HostParts,
  pathname: string,
): void {
  if (pathname !== START_PATH) return sendError(res, 404, "not_found", "Not found.");
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "Use POST.", { allow: "POST" });
  req.resume();
  // The user's agent (the one chosen in the portal's Settings); the same checks as the portal's Start, Online's
  // permission included.
  deps.manager.touch(userId);
  const attempt = deps.manager.requestStart(userId, { kind });
  if (!attempt.ok) return sendPage(res, refusalStatus(attempt.error), refusalPage(deps, attempt.error, kind, host), framing(deps, host));
  // Failures are recorded on the workspace; the starting page's next reload shows them.
  attempt.done.catch(() => undefined);
  res.writeHead(303, { location: "/", "cache-control": "no-store", "content-length": 0 });
  res.end();
}

function refusalStatus(error: StartRefusal): number {
  if (error instanceof KindMismatchError) return 409;
  if (error instanceof OnlineNotAllowedError) return 403;
  return error instanceof OnlineDisabledError ? 409 : 503;
}

function refusalPage(deps: AgentDeps, error: StartRefusal, kind: WorkspaceKind, host: HostParts): string {
  const portal = `//${host.hostname}:${deps.config.webPort}/`;
  if (error instanceof CapacityError) return capacityPage(deps.config.maxRunning);
  if (error instanceof KindMismatchError) return otherKindPage(error.running, kind, portal);
  if (error instanceof OnlineDisabledError || error instanceof OnlineNotAllowedError) return refusedPage(error.message, portal);
  return errorPage(error.message, null);
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
