import "server-only";
import type { SessionContext } from "@portal/db";
import { GatewayError, gateway, toApiError } from "./gateway";
import type { ApiError, WorkspaceInfo, WorkspaceStatusResponse } from "./gateway-types";
import { checkApiAccess } from "./request-guards";
import { getSession, renewSession } from "./session";

// Helpers for the JSON Route Handlers under app/api.

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function jsonError(status: number, error: string, message: string): Response {
  return json({ error, message } satisfies ApiError, status);
}

export function gatewayErrorResponse(error: unknown): Response {
  return json(toApiError(error), error instanceof GatewayError ? error.status : 500);
}

/** Resolves the caller's session for a JSON route (renewing it), or the error Response to return. */
export async function apiSession(options: { admin?: boolean } = {}): Promise<SessionContext | Response> {
  const access = checkApiAccess(await getSession(), options);
  if ("problem" in access) {
    const { status, error, message } = access.problem;
    return jsonError(status, error, message);
  }
  await renewSession(access.session);
  return access.session;
}

/**
 * The answer of the routes under /api/workspace: the gateway's view of the session's workspace once `pending`
 * (a read, start or stop) settles, whose workspace it is, and the agents this install offers.
 */
export async function workspaceResponse(pending: Promise<WorkspaceInfo>, session: SessionContext): Promise<Response> {
  try {
    const [info, agents] = await Promise.all([pending, gateway.agents()]);
    return json({ ...info, targetUserId: session.target.id, actingAs: session.actingAs, agents } satisfies WorkspaceStatusResponse);
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
