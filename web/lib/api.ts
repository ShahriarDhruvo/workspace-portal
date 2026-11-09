import "server-only";
import type { SessionContext } from "@portal/db";
import { GatewayError, toApiError } from "./gateway";
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

export function withTarget(info: WorkspaceInfo, session: SessionContext): WorkspaceStatusResponse {
  return { ...info, targetUserId: session.target.id, actingAs: session.actingAs };
}
