// Request checks for the JSON Route Handlers. Pure (no request context, no server-only imports), so they
// can be unit tested; lib/api.ts applies them.
import { isAgentKind, type User } from "@portal/db";
import type { ApiError, StartRequest } from "./gateway-types.ts";

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

export interface AccessProblem extends ApiError {
  status: 401 | 403;
}

/** Whatever identifies the caller: a SessionContext, or anything with the same `user` fields. */
type Caller = { user: Pick<User, "role" | "mustChangePassword"> };

/**
 * Whether a JSON route may serve this session: not when signed out (401), not while the account still
 * has a temporary password (403, the pages redirect to /change-password instead), and admin routes
 * only for the admin (403).
 */
export function checkApiAccess<S extends Caller>(
  session: S | null,
  options: { admin?: boolean } = {},
): { session: S } | { problem: AccessProblem } {
  if (!session) return { problem: { status: 401, error: "unauthorized", message: "You are signed out." } };
  if (session.user.mustChangePassword) {
    return { problem: { status: 403, error: "password_change_required", message: "Change your temporary password first." } };
  }
  if (options.admin && session.user.role !== "admin") {
    return { problem: { status: 403, error: "forbidden", message: "Administrators only." } };
  }
  return { session };
}

/** `{"agent":"…"}` is a few dozen bytes; anything much longer is not a start request. */
const MAX_START_BODY_LENGTH = 1024;

/**
 * Body of POST /api/workspace/start: empty or `{}` (the gateway's default, see StartRequest), or `{agent}`
 * naming an agent kind. Whether this install enables that agent is the gateway's call (400 `agent_unavailable`).
 */
export function parseStartRequest(body: string): { request: StartRequest } | { problem: ApiError } {
  if (body.trim() === "") return { request: {} };
  if (body.length > MAX_START_BODY_LENGTH) return { problem: { error: "bad_request", message: "The request body is too long." } };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { problem: { error: "invalid_json", message: "The request body isn't valid JSON." } };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { problem: { error: "bad_request", message: "The request body must be a JSON object." } };
  }
  const { agent } = value as Record<string, unknown>;
  if (agent === undefined) return { request: {} };
  if (!isAgentKind(agent)) return { problem: { error: "unknown_agent", message: "There is no such agent." } };
  return { request: { agent } };
}
