// Failed-login throttling: a username is locked for 15 minutes after 5 failures within 15 minutes.
// Unknown usernames are tracked the same way, so the lock reveals nothing about which names exist.
import { eq, lte, sql } from "drizzle-orm";
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

export type LoginReservation =
  | { allowed: false; lockedForMs: number }
  | { allowed: true; /** The state with this attempt counted as a failure. */ state: AttemptState };

/**
 * Takes the right to check one password. In one IMMEDIATE (write-locked) transaction it refuses a locked
 * username, or else counts the attempt as a failure up front, before the slow argon2 verification. So
 * parallel attempts can't all pass a lock check that only their later failures would have tripped:
 * the fifth reservation in the window sets the lock and every later one is refused. When the password
 * turns out to be right, the caller clears the record (clearLoginFailures).
 */
export function reserveLoginAttempt(db: PortalDb, username: string, now = Date.now()): LoginReservation {
  // better-sqlite3 transactions are synchronous on one connection, so statements issued through
  // `db` inside the callback are part of the transaction.
  return db.transaction(
    (): LoginReservation => {
      const current = readState(db, username);
      const lockedForMs = lockRemaining(current, now);
      if (lockedForMs > 0) return { allowed: false, lockedForMs };
      const state = nextFailureState(current, now);
      db.insert(loginAttempts)
        .values({ username, ...state })
        .onConflictDoUpdate({ target: loginAttempts.username, set: state })
        .run();
      return { allowed: true, state };
    },
    { behavior: "immediate" },
  );
}

/**
 * Deletes records that no longer affect anything: the lock has lifted, or (without a lock) the failure
 * window has passed. nextFailureState would start afresh for these anyway. Returns how many went.
 */
export function pruneLoginAttempts(db: PortalDb, now = Date.now()): number {
  return db
    .delete(loginAttempts)
    .where(
      lte(sql`coalesce(${loginAttempts.lockedUntil}, ${loginAttempts.firstFailureAt} + ${FAILURE_WINDOW_MS}, 0)`, now),
    )
    .run().changes;
}

export function clearLoginFailures(db: PortalDb, username: string): void {
  db.delete(loginAttempts).where(eq(loginAttempts.username, username)).run();
}
