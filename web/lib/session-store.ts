// Session-row helpers that need no request (no cookies or headers), so they can be unit tested.
import { lte, type SQL } from "drizzle-orm";
import { sessions, type PortalDb } from "@portal/db";

export interface DeletedSessions {
  /** The deleted `sessions.id` values: the gateway must close each one's open agent connections. */
  sessionIds: string[];
  /** The workspaces they were using (the owner's, or the user an admin session was viewing), to release. */
  workspaceUserIds: number[];
}

/**
 * Deletes the matching sessions. Deleting the rows only stops new requests: the caller must also
 * disconnect each session (its open terminals and streams stay up otherwise) and release the workspaces
 * (gateway.ts `endSessionsInBackground` does both).
 */
export function deleteSessions(db: PortalDb, where: SQL | undefined): DeletedSessions {
  const rows = db
    .delete(sessions)
    .where(where)
    .returning({ id: sessions.id, userId: sessions.userId, actingAsUserId: sessions.actingAsUserId })
    .all();
  return {
    sessionIds: rows.map((row) => row.id),
    workspaceUserIds: [...new Set(rows.map((row) => row.actingAsUserId ?? row.userId))],
  };
}

/** Deletes sessions that have expired. They are already refused everywhere; this keeps the table small. */
export function pruneExpiredSessions(db: PortalDb, now = Date.now()): DeletedSessions {
  return deleteSessions(db, lte(sessions.expiresAt, now));
}
