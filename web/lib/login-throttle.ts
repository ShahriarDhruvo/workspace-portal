// Failed-login throttling: a username is locked for 15 minutes after 5 failures within 15 minutes.
// Unknown usernames are tracked the same way, so the lock reveals nothing about which names exist.
import { eq } from "drizzle-orm";
import { loginAttempts, type PortalDb } from "@portal/db";

export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const LOCKOUT_MS = 15 * 60_000;

export interface AttemptState {
  failures: number;
  firstFailureAt: number | null;
  lockedUntil: number | null;
}

/** Milliseconds until the lock lifts, or 0 when the username may try again. */
export function lockRemaining(state: AttemptState | undefined, now: number): number {
  return state?.lockedUntil != null && state.lockedUntil > now ? state.lockedUntil - now : 0;
}

/** The state after one more failure. A fresh window starts once the old one (or an old lock) has passed. */
export function nextFailureState(state: AttemptState | undefined, now: number): AttemptState {
  const lockExpired = state?.lockedUntil != null && state.lockedUntil <= now;
  const inWindow =
    state != null && !lockExpired && state.firstFailureAt != null && now - state.firstFailureAt < FAILURE_WINDOW_MS;
  const failures = inWindow ? state.failures + 1 : 1;
  return {
    failures,
    firstFailureAt: inWindow ? state.firstFailureAt : now,
    lockedUntil: failures >= MAX_FAILURES ? now + LOCKOUT_MS : null,
  };
}

export function lockoutMessage(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

function readState(db: PortalDb, username: string): AttemptState | undefined {
  return db
    .select({
      failures: loginAttempts.failures,
      firstFailureAt: loginAttempts.firstFailureAt,
      lockedUntil: loginAttempts.lockedUntil,
    })
    .from(loginAttempts)
    .where(eq(loginAttempts.username, username))
    .get();
}

/** Milliseconds until `username` may try again (0 = not locked). */
export function loginLockRemaining(db: PortalDb, username: string, now = Date.now()): number {
  return lockRemaining(readState(db, username), now);
}

/** Records one failed attempt and returns the new state (check it for a fresh lock). */
export function recordLoginFailure(db: PortalDb, username: string, now = Date.now()): AttemptState {
  // better-sqlite3 transactions are synchronous on one connection, so statements issued through
  // `db` inside the callback are part of the (IMMEDIATE, write-locked) transaction.
  return db.transaction(
    () => {
      const next = nextFailureState(readState(db, username), now);
      db.insert(loginAttempts)
        .values({ username, ...next })
        .onConflictDoUpdate({ target: loginAttempts.username, set: next })
        .run();
      return next;
    },
    { behavior: "immediate" },
  );
}

export function clearLoginFailures(db: PortalDb, username: string): void {
  db.delete(loginAttempts).where(eq(loginAttempts.username, username)).run();
}
