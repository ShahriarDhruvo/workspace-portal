// A workspace's browser origin and the browser's workspace token, shared by the web app (which puts them in the
// iframe URL) and the gateway (which checks them).
//
// Every workspace is served on a port of its own: AGENT_PORT_BASE + its number (workspaceNumber: one per user, agent
// and kind). So each is its own browser origin: its localStorage, service worker, cache and scripts can never see
// another user's workspace, nor the same user's workspace of another agent or kind. (An agent's page that registers
// a service worker would otherwise answer for every agent served on its port.)
// The Web Shell sends a bearer token on every API request; the browser only ever holds this derived, session-bound
// token. The gateway checks it together with the portal session cookie and replaces it with the container's real
// token, which never leaves the server.
import crypto from "node:crypto";
import { WORKSPACE_BLOCK, WORKSPACE_REFS, workspaceNumber, type WorkspaceRef } from "./wire/index.ts";

/** Users 1 … count - 1 (AGENT_PORT_COUNT) have workspace ports, and so workspaces. */
export function hasWorkspacePorts(count: number, userId: number): boolean {
  return Number.isSafeInteger(userId) && userId >= 1 && userId < count;
}

/** The port of one of user `userId`'s workspaces, or null when the id is outside the configured range. */
export function agentPortFor(base: number, count: number, userId: number, ref: WorkspaceRef): number | null {
  return hasWorkspacePorts(count, userId) ? base + workspaceNumber(userId, ref) : null;
}

/** The workspace a port serves, or null for a port that is no workspace's. */
export function workspaceForAgentPort(base: number, count: number, port: number): { userId: number; ref: WorkspaceRef } | null {
  const number = port - base;
  if (!Number.isSafeInteger(number) || number < 0) return null;
  const userId = Math.floor(number / WORKSPACE_BLOCK);
  const ref = WORKSPACE_REFS[number % WORKSPACE_BLOCK];
  return ref !== undefined && hasWorkspacePorts(count, userId) ? { userId, ref } : null;
}

/** The first and last port the workspaces of users 1 … count - 1 can have; within it, the ports no workspace has serve nothing. */
export function agentPortRange(base: number, count: number): { first: number; last: number } {
  return { first: base + WORKSPACE_BLOCK, last: base + count * WORKSPACE_BLOCK - 1 };
}

/**
 * The token a browser session uses for one workspace: HMAC of the session id (the cookie token's hash), the
 * workspace's user id, its kind and its agent. Useless without the session cookie, and different for every
 * workspace, so one workspace's page can't call another's, not even another of the same user.
 */
export function agentBrowserToken(secret: string, sessionId: string, userId: number, ref: WorkspaceRef): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`workspace-portal/agent-token/v3\n${sessionId}\n${userId}\n${ref.kind}\n${ref.agent}`)
    .digest("base64url");
}

/** Constant-time comparison of a presented token with the expected one. */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
