// Session and audit helpers shared by the web app (which creates sessions)
// and the gateway (which only reads them to route requests).
import crypto from "node:crypto";
import { and, eq, gt, or, sql } from "drizzle-orm";
import type { PortalDb } from "./db.ts";
import { auditLog, sessions, users, type Session, type User } from "./schema.ts";

/** Cookie set by the web app. Browsers send it to every port on the same host, so the gateway sees it too. */
export const SESSION_COOKIE_NAME = "portal_session";

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Reads one cookie value from a raw Cookie header. */
export function readCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

export interface SessionContext {
  session: Session;
  /** The signed-in account. */
  user: User;
  /** Whose workspace this session uses: the user themself, or the user an admin is viewing. */
  target: User;
  /** True when an admin is viewing someone else's workspace. */
  actingAs: boolean;
}

/**
 * Resolves a session by its token hash. Returns null for unknown or expired sessions
 * and for deactivated accounts. An admin's acting-as target is used only while it still exists.
 */
export function loadSessionContext(db: PortalDb, tokenHash: string, now = Date.now()): SessionContext | null {
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, tokenHash), gt(sessions.expiresAt, now), eq(users.active, true)))
    .get();
  if (!row) return null;

  const { session, user } = row;
  if (user.role === "admin" && session.actingAsUserId != null && session.actingAsUserId !== user.id) {
    const target = db.select().from(users).where(eq(users.id, session.actingAsUserId)).get();
    if (target) return { session, user, target, actingAs: true };
  }
  return { session, user, target: user, actingAs: false };
}

/**
 * Number of unexpired sessions that use this user's workspace: the user's own sessions
 * (only while the account is active) plus any admin session viewing it.
 * When this reaches zero the gateway stops the container.
 */
export function countSessionsUsingWorkspace(db: PortalDb, userId: number, now = Date.now()): number {
  const own = db
    .select({ n: sql<number>`count(*)` })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        gt(sessions.expiresAt, now),
        eq(users.active, true),
        or(
          and(eq(sessions.userId, userId), sql`(${sessions.actingAsUserId} IS NULL OR ${sessions.actingAsUserId} = ${userId})`),
          and(eq(sessions.actingAsUserId, userId), eq(users.role, "admin")),
        ),
      ),
    )
    .get();
  return Number(own?.n ?? 0);
}

export type AuditAction =
  | "login"
  | "login_failed"
  | "logout"
  | "password_changed"
  | "user_created"
  | "user_updated"
  | "password_reset"
  | "user_deactivated"
  | "user_activated"
  | "user_deleted"
  | "admin_opened_workspace"
  | "admin_exited_workspace"
  | "workspace_started"
  | "workspace_stopped"
  | "workspace_error";

export function writeAudit(
  db: PortalDb,
  entry: { action: AuditAction; actorUserId?: number | null; targetUserId?: number | null; details?: unknown },
): void {
  db.insert(auditLog)
    .values({
      at: Date.now(),
      action: entry.action,
      actorUserId: entry.actorUserId ?? null,
      targetUserId: entry.targetUserId ?? null,
      details: entry.details === undefined ? null : JSON.stringify(entry.details),
    })
    .run();
}

/** "First Middle Last", skipping an empty middle name. */
export function displayName(user: Pick<User, "firstName" | "middleName" | "lastName">): string {
  return [user.firstName, user.middleName, user.lastName].filter((p) => p && p.trim()).join(" ");
}
