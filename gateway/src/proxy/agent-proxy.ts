// The agent ports: every browser request for a workspace, one port per user and kind, so each workspace (and each of
// a user's two kinds) is its own browser origin. A request that passes the access checks is streamed to that user's
// agent when the port's kind is the one running, with the container's credential added by the agent's driver. Loading
// a page never starts a workspace (the portal does, where the kind is chosen): only "Try again" (a POST) starts this
// port's kind, after a failure or at the cap. WebSocket upgrades go to ws-relay.ts.
import type http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokensEqual, type WorkspaceKind } from "@portal/core";
import { checkAgentAccess, INVALID_TOKEN, unavailable, type AgentAccess, type AgentDeps, type WorkspaceSurface } from "./agent-access.ts";
import { driverFor } from "../agents/index.ts";
import { MIB, PREVIEW_PORT_OFFSET, type Config } from "../config.ts";
import { connectionOf, connectionRole } from "./connections.ts";
import { forward } from "../lib/forward.ts";
import { bearerToken, frameAncestorSources, workspaceResponseHeaders, type FramePolicy, type HeaderMap } from "./headers.ts";
import { createStreamingServer, HttpError, isDocumentNavigation, sendError, splitTarget } from "../lib/http-util.ts";
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

/**
 * The path as a lenient router might see it: percent-decoded, backslashes and repeated slashes folded, dot segments
 * resolved, lower-cased. Used only to refuse an agent's blocked paths in any spelling.
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

/** Returns a function that creates one agent server; main.ts listens with one per workspace port. */
export function createAgentServerFactory(deps: AgentDeps): () => http.Server {
  const onUpgrade = createWsRelay(deps);
  return () => createStreamingServer(deps.log, "agent", (req, res) => handleRequest(deps, req, res)).on("upgrade", onUpgrade);
}

/** A request that passed the access checks, and who may frame its answers. */
type Admitted = Extract<AgentAccess, { ok: true }> & { method: string; target: string; navigation: boolean; frame: FramePolicy };

const portalUrl = (frame: FramePolicy, path = "/"): string => frame.portal + path;

/** The portal and, for a preview, its workspace's agent port, as the browser names them on this host. */
function framePolicy({ scheme, webPort }: Config, hostname: string, agentPort?: number): FramePolicy {
  const host = `${scheme}://${hostname}`;
  return { portal: scheme === "https" ? host : `${host}:${webPort}`, agent: agentPort === undefined ? undefined : `${host}:${agentPort}` };
}

/** The access checks. A refused request is answered here: a signed-out or other-workspace page load with a page, the rest with the JSON error. */
export function admit(deps: AgentDeps, req: IncomingMessage, res: ServerResponse, surface: WorkspaceSurface): Admitted | null {
  const method = req.method ?? "GET";
  const target = req.url ?? "";
  const navigation = isDocumentNavigation(method, req.headers);
  const access: AgentAccess = target.startsWith("/")
    ? checkAgentAccess(req, deps, false, surface)
    : { ok: false, status: 400, code: "bad_request", message: "Unsupported request target.", host: null };
  // A preview is framed by its workspace's Web Shell (the agent port), inside the portal.
  const agentPort = surface === "preview" ? (req.socket.localPort ?? 0) - PREVIEW_PORT_OFFSET : undefined;
  const frame = access.host && framePolicy(deps.config, access.host.hostname, agentPort);
  if (access.ok) return { ...access, method, target, navigation, frame: frame! };
  if (navigation && frame && access.status === 401) sendPage(res, 401, signedOutPage(portalUrl(frame, "/login")), frame);
  else if (navigation && frame && access.code === "other_workspace") sendPage(res, 403, otherWorkspacePage(portalUrl(frame)), frame);
  else sendError(res, access.status, access.code, access.message);
  return null;
}

/**
 * Streams an admitted request into the workspace. A body over the upload limit is a 413 that closes the connection;
 * when nothing answers, `unreachable` says what to tell the browser (a page for a page load).
 */
export async function relay(
  deps: AgentDeps,
  req: IncomingMessage,
  res: ServerResponse,
  { method, navigation, frame, context, userId }: Admitted,
  to: {
    url: URL;
    headers: HeaderMap;
    responseHeaders: (upstream: IncomingMessage) => HeaderMap;
    unreachable: (error: Error) => { page: string; code: string; message: string };
  },
): Promise<void> {
  // An open tab polls every few seconds: this session has the workspace open.
  deps.connections.seen(userId, context.session.id, connectionRole(context));
  const limit = deps.config.uploadLimitBytes;
  const tooLarge = (response: ServerResponse): void =>
    sendError(response, 413, "payload_too_large", `Uploads are limited to ${limit / MIB} MB.`, { connection: "close" });
  if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(res);
  await forward(req, res, {
    url: to.url,
    method,
    headers: to.headers,
    bodyLimit: limit,
    responseHeaders: (incoming) => {
      // An event stream is an open tab watching a session: counted as a connection, and closed with the session.
      if (String(incoming.headers["content-type"] ?? "").startsWith("text/event-stream")) {
        res.once("close", deps.connections.add(connectionOf(userId, context, () => res.destroy())));
      }
      return to.responseHeaders(incoming);
    },
    onError: (error, response) => {
      if (error instanceof HttpError) return tooLarge(response);
      const { page, code, message } = to.unreachable(error);
      if (navigation) sendPage(response, 502, page, frame);
      else sendError(response, 502, code, message);
    },
  });
}

async function handleRequest(deps: AgentDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admitted = admit(deps, req, res, "agent");
  if (!admitted) return;
  const { method, target, navigation, frame, userId, kind } = admitted;
  const { pathname } = splitTarget(target);
  if (pathname.startsWith(PORTAL_PATH_PREFIX)) return handlePortalPath(deps, req, res, userId, kind, frame, pathname);

  // Whatever the agent, a token the browser presents must be this session's token for this workspace and kind.
  const presentsToken = req.headers.authorization !== undefined;
  if (presentsToken) {
    const presented = bearerToken(req.headers.authorization);
    if (presented === null || !tokensEqual(presented, admitted.browserToken)) return sendError(res, 401, INVALID_TOKEN.code, INVALID_TOKEN.message);
  }

  // Only this kind's container: while the other kind runs, nothing here reaches it.
  const upstream = deps.manager.upstream(userId, kind);
  if (!upstream) return handleUnavailable(deps, res, userId, kind, navigation, frame);
  const driver = driverFor(upstream.agent);
  const canonical = canonicalPath(pathname);
  if (driver.blockedPrefixes.some((prefix) => canonical.startsWith(prefix))) {
    return sendError(res, 403, "not_available", "This feature is not available in the portal.");
  }

  if (navigation || driver.isUserAction(method, pathname)) deps.manager.touch(userId);
  await relay(deps, req, res, admitted, {
    url: new URL(`http://${upstream.host}:${upstream.port}${target}`),
    // A token agent's UI authenticates with that token: only requests that presented it get the container's
    // credential; the others (the page and its static assets) go through unauthorised, and the agent answers anything
    // else with 401 itself. A cookie agent gets it on every request: the session and port checks authorise it.
    headers: driver.requestHeaders(req.headers, upstream, { authorised: driver.browserAuth === "cookie" || presentsToken }),
    responseHeaders: (incoming) => workspaceResponseHeaders(incoming.headers, frame, incoming.statusCode),
    unreachable: (error) => {
      deps.log.warn("workspace did not answer", { userId, error });
      deps.manager.checkContainer(userId);
      return { page: unreachablePage(), code: "workspace_unreachable", message: "The workspace did not answer." };
    },
  });
}

/**
 * This kind's workspace is not ready. A page load gets a themed page: starting (it reloads), the other kind running,
 * the error with "Try again", or stopped with a link to the portal; anything else the JSON error.
 */
export function handleUnavailable(deps: AgentDeps, res: ServerResponse, userId: number, kind: WorkspaceKind, navigation: boolean, frame: FramePolicy): void {
  const info = deps.manager.info(userId);
  const no = unavailable(info, kind);
  if (!navigation) return sendError(res, no.status, no.code, no.message, no.headers);
  if (no.status === 409) return sendPage(res, 409, otherKindPage(info.kind, kind, portalUrl(frame)), frame);
  if (no.code === "workspace_starting") return sendPage(res, 503, startingPage(kind), frame, no.headers);
  if (no.code === "workspace_error") return sendPage(res, 503, errorPage("Something went wrong while it was starting.", info.lastError), frame);
  sendPage(res, 503, stoppedPage(kind, portalUrl(frame)), frame);
}

/** Gateway-owned paths: the "Try again" form of the capacity and error pages, for this port's kind. */
export function handlePortalPath(
  deps: AgentDeps,
  req: IncomingMessage,
  res: ServerResponse,
  userId: number,
  kind: WorkspaceKind,
  frame: FramePolicy,
  pathname: string,
): void {
  if (pathname !== START_PATH) return sendError(res, 404, "not_found", "Not found.");
  if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "Use POST.", { allow: "POST" });
  req.resume();
  deps.manager.touch(userId);
  // The same checks as the portal's Start, Online's permission included.
  const attempt = deps.manager.requestStart(userId, { kind });
  if (!attempt.ok) {
    const { status, code, message } = attempt.error;
    const portal = portalUrl(frame);
    // As on the control API for these three; any other refusal is a 503 here (there, 4xx).
    if (code === "kind_mismatch") return sendPage(res, status, otherKindPage(deps.manager.info(userId).kind, kind, portal), frame);
    if (code === "online_disabled" || code === "online_not_allowed") return sendPage(res, status, refusedPage(message, portal), frame);
    return sendPage(res, 503, code === "capacity" ? capacityPage(deps.config.maxRunning) : errorPage(message, null), frame);
  }
  // Failures are recorded on the workspace; the starting page's next reload shows them.
  attempt.done.catch(() => undefined);
  res.writeHead(303, { location: "/", "cache-control": "no-store", "content-length": 0 });
  res.end();
}

export function sendPage(res: ServerResponse, status: number, html: string, frame: FramePolicy, headers: Record<string, string> = {}): void {
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
