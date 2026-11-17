// Per-user workspace origins and the browser's workspace token, shared by the web app (which puts
// them in the iframe URL) and the gateway (which checks them).
//
// Every user's workspace is served on its own port, one range per kind (Private: AGENT_PORT_BASE + id,
// Online: ONLINE_AGENT_PORT_BASE + id), so each workspace is its own browser origin: its localStorage,
// service worker and scripts can never see another user's workspace, nor the same user's other kind.
// The Web Shell sends a bearer token on every API request; the browser only ever holds this
// derived, session-bound token. The gateway checks it together with the portal session cookie and
// replaces it with the container's real token, which never leaves the server.
import crypto from "node:crypto";
import type { WorkspaceKind } from "./wire/index.ts";

/** Port of user `userId`'s workspace, or null when the id is outside the configured range. */
export function agentPortFor(base: number, count: number, userId: number): number | null {
  if (!Number.isSafeInteger(userId) || userId < 1 || userId >= count) return null;
  return base + userId;
}

/** The user a workspace port belongs to, or null for ports outside the range. */
export function userIdForAgentPort(base: number, count: number, port: number): number | null {
  const userId = port - base;
  return Number.isSafeInteger(userId) && userId >= 1 && userId < count ? userId : null;
}

/**
 * The token a browser session uses for one workspace: HMAC of the session id (the cookie token's
 * hash), the workspace's user id and its kind. Useless without the session cookie, and different per
 * workspace and kind, so one workspace's page can't call another's, not even the same user's other kind.
 */
export function agentBrowserToken(secret: string, sessionId: string, userId: number, kind: WorkspaceKind): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`workspace-portal/agent-token/v2\n${sessionId}\n${userId}\n${kind}`)
    .digest("base64url");
}

/** Constant-time comparison of a presented token with the expected one. */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
