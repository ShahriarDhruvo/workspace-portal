// Request checks for the JSON Route Handlers. Pure (no request context, no server-only imports), so they
// can be unit tested; lib/api.ts applies them.
import type { User } from "@portal/db";
import type { ApiError } from "./gateway-types.ts";

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
