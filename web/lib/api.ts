import "server-only";
import type { SessionContext } from "@portal/db";
import { GatewayError } from "./gateway";
import type { ApiError, WorkspaceInfo, WorkspaceStatusResponse } from "./gateway-types";
import { getSession, renewSession } from "./session";

// Helpers for the JSON Route Handlers under app/api.

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function jsonError(status: number, error: string, message: string): Response {
  return json({ error, message } satisfies ApiError, status);
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof GatewayError) return { error: error.code, message: error.message };
  console.error("[api] unexpected error:", error);
  return { error: "internal", message: "Something went wrong in the portal." };
}

export function gatewayErrorResponse(error: unknown): Response {
  const body = toApiError(error);
  return json(body, error instanceof GatewayError ? error.status : 500);
}

/** Resolves the caller's session for a JSON route (renewing it), or the error Response to return. */
export async function apiSession(options: { admin?: boolean } = {}): Promise<SessionContext | Response> {
  const session = await getSession();
  if (!session) return jsonError(401, "unauthorized", "You are signed out.");
  if (session.user.mustChangePassword) {
    return jsonError(403, "password_change_required", "Change your temporary password first.");
  }
  if (options.admin && session.user.role !== "admin") return jsonError(403, "forbidden", "Administrators only.");
  await renewSession(session);
  return session;
}

/**
 * CSRF guard for state-changing routes. SameSite=Lax still lets same-site pages (such as content
 * served on the agent port, which is the same host) send cookies, so the Origin must be this host.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // The portal is reached directly (or through a proxy that keeps Host), so X-Forwarded-Host,
  // which any client can send, is deliberately ignored.
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function withTarget(info: WorkspaceInfo, session: SessionContext): WorkspaceStatusResponse {
  return { ...info, targetUserId: session.target.id, actingAs: session.actingAs };
}
