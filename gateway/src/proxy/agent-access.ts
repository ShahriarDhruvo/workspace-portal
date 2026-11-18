// The checks every request to a workspace's ports (HTTP and WebSocket) passes before anything else. The port, not the
// session, says which workspace a request is for (the user and the kind). It gets through only with a sane Host, an
// Origin that is exactly this port's (or none) and a portal session whose current workspace is this one (an admin must
// have opened it from the admin console). The preview ports (the agent port + PREVIEW_PORT_OFFSET) pass the same
// checks, where a same-site page load may also open the preview in a tab of its own.
import type { IncomingMessage } from "node:http";
import { agentBrowserToken, userIdForAgentPort, WORKSPACE_KIND_NAMES, WORKSPACE_KINDS, type SessionContext, type WorkspaceKind, type WorkspaceStatus } from "@portal/core";
import { PREVIEW_PORT_OFFSET, type Config } from "../config.ts";
import type { ConnectionRegistry } from "./connections.ts";
import { originMatchesHost, parseHostHeader, rejectsCrossSite, rejectsSameSite, type HostParts } from "./headers.ts";
import type { Logger } from "../lib/log.ts";
import type { SessionCache } from "./session-cache.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";

export interface AgentDeps {
  config: Config;
  manager: WorkspaceManager;
  sessions: SessionCache;
  connections: ConnectionRegistry;
  log: Logger;
}

export type AgentAccess =
  | {
      ok: true;
      host: HostParts;
      context: SessionContext;
      /** Whose workspace this port serves, and which of that user's two. */
      userId: number;
      kind: WorkspaceKind;
      /** The token this session's browser must present for this workspace and kind. */
      browserToken: string;
    }
  | { ok: false; status: 400 | 401 | 403 | 404; code: string; message: string; host: HostParts | null };

/** 401 for a request whose workspace token is not this session's token for this workspace. */
export const INVALID_TOKEN = { code: "invalid_token", message: "Reload the portal page to reconnect to your workspace." } as const;

/**
 * Why a request can't reach this kind's container: 409 while the user's other kind is starting, running or stopping
 * (only one runs at a time), else 503. Nothing here starts the workspace: an open tab's reconnect loop must not wake it.
 */
export function unavailable(
  info: { status: WorkspaceStatus; kind: WorkspaceKind },
  kind: WorkspaceKind,
): { status: 409 | 503; code: string; message: string; headers: Record<string, string> } {
  const names = WORKSPACE_KIND_NAMES;
  if (info.kind !== kind && ["starting", "running", "stopping"].includes(info.status)) {
    return { status: 409, code: "kind_mismatch", message: `Your ${names[info.kind]} workspace is running, not this one (${names[kind]}).`, headers: {} };
  }
  const status = info.kind === kind ? info.status : "stopped";
  if (status === "starting" || status === "running") {
    return { status: 503, code: "workspace_starting", message: "The workspace is starting.", headers: { "retry-after": "2" } };
  }
  if (status === "error") return { status: 503, code: "workspace_error", message: "The workspace failed to start.", headers: {} };
  return { status: 503, code: "workspace_stopped", message: "The workspace is not running.", headers: {} };
}

/** Which of a workspace's ports a server answers on: its agent's, or its web apps' (preview-proxy.ts). */
export type WorkspaceSurface = "agent" | "preview";

export function checkAgentAccess(
  req: IncomingMessage,
  deps: Pick<AgentDeps, "config" | "sessions">,
  upgrade: boolean,
  surface: WorkspaceSurface = "agent",
): AgentAccess {
  const { config } = deps;
  const method = req.method ?? "GET";
  const host = parseHostHeader(req.headers.host);
  const no = (status: 400 | 401 | 403 | 404, code: string, message: string): AgentAccess => ({ ok: false, status, code, message, host });
  if (!host) return no(400, "bad_request", "Missing or invalid Host header.");
  const agentPort = (req.socket.localPort ?? NaN) - (surface === "preview" ? PREVIEW_PORT_OFFSET : 0);
  const [workspace] = WORKSPACE_KINDS.flatMap((kind) => {
    const userId = userIdForAgentPort(config.workspace.kinds[kind].agentPortBase, config.agentPortCount, agentPort);
    return userId === null ? [] : [{ userId, kind }];
  });
  if (!workspace) return no(404, "not_found", "No workspace here.");
  const { userId, kind } = workspace;
  const { origin } = req.headers;
  if (origin !== undefined && !originMatchesHost(origin, host)) return no(403, "forbidden_origin", "Cross-origin requests are not allowed.");
  if (rejectsCrossSite(method, req.headers, upgrade)) return no(403, "forbidden_cross_site", "Cross-site requests are not allowed.");
  if (rejectsSameSite(method, req.headers, upgrade, surface === "preview")) {
    return no(403, "forbidden_same_site", "Requests from another port of this host are not allowed.");
  }
  const context = deps.sessions.fromCookieHeader(req.headers.cookie);
  if (!context) return no(401, "unauthenticated", "You are signed out.");
  if (context.target.id !== userId) return no(403, "other_workspace", "This session is not using this workspace.");
  return { ok: true, host, context, userId, kind, browserToken: agentBrowserToken(config.controlSecret, context.session.id, userId, kind) };
}
