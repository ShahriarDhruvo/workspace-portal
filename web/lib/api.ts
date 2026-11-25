import "server-only";
import type { AgentInfo, AgentKind, ApiError, SessionContext, WorkspaceInfo, WorkspaceServer } from "@portal/core";
import { startingAgent } from "./agent-choice";
import { GatewayError, gateway, toApiError } from "./gateway";
import { checkApiAccess, isSameOrigin } from "./request-guards";
import { getSession, renewSession } from "./session";

/** GET /api/workspace/status, POST /api/workspace/start and POST /api/workspace/stop. */
export interface WorkspaceStatusResponse extends WorkspaceInfo {
  /** Whose workspace this session uses (the gateway routes the iframe there). */
  targetUserId: number;
  /** The agents enabled on this install, in display order. */
  agents: AgentInfo[];
  /**
   * The agent a start would launch: the workspace owner's choice (made on Home) while it is enabled, else the first
   * enabled agent; null when none is enabled.
   */
  nextAgent: AgentKind | null;
}

/** GET /api/workspace/servers. */
export interface WorkspaceServersResponse {
  /**
   * The gateway port that shows the servers of the workspace that runs; null when none runs and is ready, or its
   * user id is outside AGENT_PORT_COUNT (no servers then).
   */
  previewPort: number | null;
  servers: WorkspaceServer[];
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function jsonError(status: number, error: string, message: string): Response {
  return json({ error, message } satisfies ApiError, status);
}

/**
 * A JSON Route Handler. Anything but a GET or HEAD must come from this origin: a workspace page on another port of the same
 * site gets the session cookie too (browsers send no Origin with a same-origin GET, so those can't be checked). The
 * caller's session is checked and renewed; what `handle` returns is sent as JSON, a gateway error with its status.
 */
export function route(options: { admin?: boolean }, handle: (session: SessionContext, request: Request) => unknown) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
    const access = checkApiAccess(await getSession(), options);
    if ("problem" in access) {
      const { status, error, message } = access.problem;
      return jsonError(status, error, message);
    }
    await renewSession(access.session);
    try {
      const answer = await handle(access.session, request);
      return answer instanceof Response ? answer : json(answer);
    } catch (error) {
      return json(toApiError(error), error instanceof GatewayError ? error.status : 500);
    }
  };
}

/**
 * The answer of the routes under /api/workspace: the gateway's view of the session's workspace once `pending`
 * (a read, start or stop) settles, whose workspace it is, the agents this install offers and the one a start
 * would launch (the owner's harness).
 */
export async function workspaceStatus(pending: Promise<WorkspaceInfo>, session: SessionContext): Promise<WorkspaceStatusResponse> {
  const [info, agents] = await Promise.all([pending, gateway.agents()]);
  return { ...info, targetUserId: session.target.id, agents, nextAgent: startingAgent(session.target.agent, agents) };
}
