// Checks every agent-port request (HTTP and WebSocket) passes before anything else happens.
//
// Each user's workspace has its own port per kind (Private: AGENT_PORT_BASE + user id, Online:
// ONLINE_AGENT_PORT_BASE + user id), so the port, not the session, decides which workspace a request is for:
// the user and the kind. A request gets through only with:
//   * a sane Host and an Origin that is exactly this workspace's origin (or none),
//   * a valid portal session whose current workspace is this one (an admin must have opened it
//     from the admin console; everyone else only ever has their own),
// and, for anything the Web Shell authenticates, the session-bound workspace token of this kind (checked by the
// proxy, which swaps it for the container's real token). Whether the port's kind is the one running is the
// proxy's next question (otherKindError).
import type { IncomingMessage } from "node:http";
import {
  agentBrowserToken,
  userIdForAgentPort,
  WORKSPACE_KIND_NAMES,
  WORKSPACE_KINDS,
  type SessionContext,
  type WorkspaceKind,
  type WorkspaceStatus,
} from "@portal/db";
import type { Config } from "./config.ts";
import type { ConnectionRegistry } from "./connections.ts";
import { originMatchesHost, parseHostHeader, rejectsCrossSite, rejectsSameSite, type HostParts } from "./headers.ts";
import type { Logger } from "./log.ts";
import type { SessionCache } from "./session-cache.ts";
import type { WorkspaceManager } from "./workspaces.ts";

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
      /** Whose workspace this port serves. */
      userId: number;
      /** Which of that user's two workspaces this port serves. */
      kind: WorkspaceKind;
      /** The token this session's browser must present for this workspace (this kind's). */
      browserToken: string;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404;
      code: string;
      message: string;
      host: HostParts | null;
    };

/** 401 for a request whose workspace token is not this session's token for this workspace. */
export const INVALID_TOKEN = { code: "invalid_token", message: "Reload the portal page to reconnect to your workspace." } as const;

/**
 * The 503 for an API request or WebSocket that reaches a workspace that isn't ready. It never
 * starts the workspace: an open tab's reconnect loop must not wake a stopped one.
 */
export function unavailableError(status: WorkspaceStatus): { code: string; message: string; headers: Record<string, string> } {
  if (status === "starting" || status === "running") {
    return { code: "workspace_starting", message: "The workspace is starting.", headers: { "retry-after": "2" } };
  }
  if (status === "error") return { code: "workspace_error", message: "The workspace failed to start.", headers: {} };
  return { code: "workspace_stopped", message: "The workspace is not running.", headers: {} };
}

/**
 * The 409 for a request to one kind's port while the user's other kind is starting, running or stopping (only one
 * runs at a time): it never reaches that container. Null when it is this kind, or nothing, that runs.
 */
export function otherKindError(
  running: { status: WorkspaceStatus; kind: WorkspaceKind },
  kind: WorkspaceKind,
): { code: string; message: string; running: WorkspaceKind } | null {
  if (running.kind === kind || !["starting", "running", "stopping"].includes(running.status)) return null;
  const message = `Your ${WORKSPACE_KIND_NAMES[running.kind]} workspace is running, not this one (${WORKSPACE_KIND_NAMES[kind]}).`;
  return { code: "kind_mismatch", message, running: running.kind };
}

/** The workspace (user id and kind) a connection reached, from the local port it arrived on. */
export function workspaceForPort(config: Config, localPort: number | undefined): { userId: number; kind: WorkspaceKind } | null {
  if (localPort === undefined) return null;
  for (const kind of WORKSPACE_KINDS) {
    const userId = userIdForAgentPort(config.workspace.kinds[kind].agentPortBase, config.agentPortCount, localPort);
    if (userId !== null) return { userId, kind };
  }
  return null;
}

export function checkAgentAccess(req: IncomingMessage, deps: Pick<AgentDeps, "config" | "sessions">, upgrade: boolean): AgentAccess {
  const host = parseHostHeader(req.headers.host);
  if (!host) return { ok: false, status: 400, code: "bad_request", message: "Missing or invalid Host header.", host };
  const workspace = workspaceForPort(deps.config, req.socket.localPort);
  if (workspace === null) return { ok: false, status: 404, code: "not_found", message: "No workspace here.", host };
  const { userId, kind } = workspace;
  const { origin } = req.headers;
  if (origin !== undefined && !originMatchesHost(origin, host)) {
    return { ok: false, status: 403, code: "forbidden_origin", message: "Cross-origin requests are not allowed.", host };
  }
  if (rejectsCrossSite(req.method ?? "GET", req.headers, upgrade)) {
    return { ok: false, status: 403, code: "forbidden_cross_site", message: "Cross-site requests are not allowed.", host };
  }
  if (rejectsSameSite(req.method ?? "GET", req.headers, upgrade)) {
    return { ok: false, status: 403, code: "forbidden_same_site", message: "Requests from another port of this host are not allowed.", host };
  }
  const context = deps.sessions.fromCookieHeader(req.headers.cookie);
  if (!context) return { ok: false, status: 401, code: "unauthenticated", message: "You are signed out.", host };
  if (context.target.id !== userId) {
    return { ok: false, status: 403, code: "other_workspace", message: "This session is not using this workspace.", host };
  }
  return { ok: true, host, context, userId, kind, browserToken: agentBrowserToken(deps.config.controlSecret, context.session.id, userId, kind) };
}
