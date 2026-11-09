// Checks every agent-port request (HTTP and WebSocket) passes before anything else happens.
//
// Each user's workspace has its own port (AGENT_PORT_BASE + user id), so the port, not the session,
// decides which workspace a request is for. A request gets through only with:
//   * a sane Host and an Origin that is exactly this workspace's origin (or none),
//   * a valid portal session whose current workspace is this one (an admin must have opened it
//     from the admin console; everyone else only ever has their own),
// and, for anything the Web Shell authenticates, the session-bound workspace token (checked by the
// proxy, which swaps it for the container's real token).
import type { IncomingMessage } from "node:http";
import { agentBrowserToken, userIdForAgentPort, type SessionContext } from "@portal/db";
import type { Config } from "./config.ts";
import type { ConnectionRegistry } from "./connections.ts";
import { originMatchesHost, parseHostHeader, rejectsCrossSite, type HostParts } from "./headers.ts";
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
      /** The token this session's browser must present for this workspace. */
      browserToken: string;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404;
      code: string;
      message: string;
      host: HostParts | null;
    };

/** The workspace (user id) a connection reached, from the local port it arrived on. */
export function workspaceForSocket(config: Config, localPort: number | undefined): number | null {
  return localPort === undefined ? null : userIdForAgentPort(config.agentPortBase, config.agentPortCount, localPort);
}

export function checkAgentAccess(req: IncomingMessage, deps: Pick<AgentDeps, "config" | "sessions">, upgrade: boolean): AgentAccess {
  const host = parseHostHeader(req.headers.host);
  if (!host) return { ok: false, status: 400, code: "bad_request", message: "Missing or invalid Host header.", host };
  const userId = workspaceForSocket(deps.config, req.socket.localPort);
  if (userId === null) return { ok: false, status: 404, code: "not_found", message: "No workspace here.", host };
  const { origin } = req.headers;
  if (origin !== undefined && !originMatchesHost(origin, host)) {
    return { ok: false, status: 403, code: "forbidden_origin", message: "Cross-origin requests are not allowed.", host };
  }
  if (rejectsCrossSite(req.method ?? "GET", req.headers, upgrade)) {
    return { ok: false, status: 403, code: "forbidden_cross_site", message: "Cross-site requests are not allowed.", host };
  }
  const context = deps.sessions.fromCookieHeader(req.headers.cookie);
  if (!context) return { ok: false, status: 401, code: "unauthenticated", message: "You are signed out.", host };
  if (context.target.id !== userId) {
    return { ok: false, status: 403, code: "other_workspace", message: "This session is not using this workspace.", host };
  }
  return { ok: true, host, context, userId, browserToken: agentBrowserToken(deps.config.controlSecret, context.session.id, userId) };
}
