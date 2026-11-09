import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginAttempts, openDatabase } from "@portal/db";
import {
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
  MAX_FAILURES,
  clearLoginFailures,
  lockRemaining,
  lockoutMessage,
  nextFailureState,
  pruneLoginAttempts,
  reserveLoginAttempt,
  type AttemptState,
  type LoginReservation,
} from "./login-throttle.ts";

const MINUTE = 60_000;

function fail(times: number, start: number, step: number): AttemptState | undefined {
  let state: AttemptState | undefined;
  for (let i = 0; i < times; i++) state = nextFailureState(state, start + i * step);
  return state;
}

test("the fifth failure within 15 minutes locks the username for 15 minutes", () => {
  const t0 = 1_000_000;
  const four = fail(MAX_FAILURES - 1, t0, MINUTE)!;
  assert.equal(four.failures, 4);
  assert.equal(lockRemaining(four, t0 + 4 * MINUTE), 0);

  const fifthAt = t0 + 4 * MINUTE;
  const five = nextFailureState(four, fifthAt);
  assert.equal(five.lockedUntil, fifthAt + LOCKOUT_MS);
  assert.equal(lockRemaining(five, fifthAt), LOCKOUT_MS);
  assert.equal(lockRemaining(five, fifthAt + LOCKOUT_MS - 1), 1);
  assert.equal(lockRemaining(five, fifthAt + LOCKOUT_MS), 0);
});

test("failures spread over more than 15 minutes never lock", () => {
  const state = fail(10, 0, FAILURE_WINDOW_MS / 4 + 1);
  assert.equal(lockRemaining(state, 10 * FAILURE_WINDOW_MS), 0);
  assert.ok(state!.failures < MAX_FAILURES);
});

test("a new window starts after the old one passes and after a lock expires", () => {
  const old = fail(3, 0, MINUTE)!;
  const fresh = nextFailureState(old, FAILURE_WINDOW_MS + 1);
  assert.deepEqual(fresh, { failures: 1, firstFailureAt: FAILURE_WINDOW_MS + 1, lockedUntil: null });

  const locked = fail(MAX_FAILURES, 0, 1)!;
  const afterLock = nextFailureState(locked, locked.lockedUntil!);
  assert.equal(afterLock.failures, 1);
  assert.equal(afterLock.lockedUntil, null);
});

test("lockout message rounds up to whole minutes", () => {
  assert.equal(lockoutMessage(LOCKOUT_MS), "Too many attempts. Try again in 15 minutes.");
  assert.equal(lockoutMessage(14 * MINUTE + 1), "Too many attempts. Try again in 15 minutes.");
  assert.equal(lockoutMessage(30_000), "Too many attempts. Try again in 1 minute.");
  assert.equal(lockoutMessage(1), "Too many attempts. Try again in 1 minute.");
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-throttle-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  return {
    db,
    [Symbol.dispose]() {
      db.$client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function lockedFor(reservation: LoginReservation): number {
  return reservation.allowed ? 0 : reservation.lockedForMs;
}

test("reservations count each attempt before it is verified, lock on the fifth and clear per username", () => {
  using t = tempDb();
  const { db } = t;
  const now = 5_000_000;
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    const reservation = reserveLoginAttempt(db, "alice", now + i);
    assert.ok(reservation.allowed && reservation.state.failures === i + 1 && reservation.state.lockedUntil === null);
  }
  // The fifth attempt may still check its password; its reservation already sets the lock.
  const fifth = reserveLoginAttempt(db, "alice", now + 10);
  assert.ok(fifth.allowed);
  assert.equal(fifth.state.failures, MAX_FAILURES);
  assert.equal(lockRemaining(fifth.state, now + 10), LOCKOUT_MS);
  assert.equal(lockedFor(reserveLoginAttempt(db, "alice", now + 10)), LOCKOUT_MS, "the sixth is refused");
  assert.ok(reserveLoginAttempt(db, "bob", now + 10).allowed, "other usernames are unaffected");
  // A refused attempt is not counted, so it doesn't extend the lock.
  assert.equal(lockedFor(reserveLoginAttempt(db, "alice", now + LOCKOUT_MS + 9)), 1);
  // A correct password clears the record.
  clearLoginFailures(db, "alice");
  const fresh = reserveLoginAttempt(db, "alice", now + 20);
  assert.ok(fresh.allowed && fresh.state.failures === 1);
});

test("a burst of parallel attempts gets at most five password checks", async () => {
  using t = tempDb();
  const { db } = t;
  // What login() does: reserve, then await the slow verification.
  const attempt = async () => {
    const reservation = reserveLoginAttempt(db, "carol", 1_000);
    if (!reservation.allowed) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return true;
  };
  const checked = await Promise.all(Array.from({ length: 20 }, attempt));
  assert.equal(checked.filter(Boolean).length, MAX_FAILURES);
});

test("pruning removes only records that no longer matter", () => {
  using t = tempDb();
  const { db } = t;
  const now = 50_000_000;
  const rows = [
    { username: "lock-lifted", failures: 5, firstFailureAt: now - 20 * 60_000, lockedUntil: now - 1 },
    { username: "lock-lifts-now", failures: 5, firstFailureAt: now - 15 * 60_000, lockedUntil: now },
    { username: "still-locked", failures: 5, firstFailureAt: now - 60_000, lockedUntil: now + 1 },
    { username: "window-passed", failures: 3, firstFailureAt: now - FAILURE_WINDOW_MS, lockedUntil: null },
    { username: "in-window", failures: 3, firstFailureAt: now - FAILURE_WINDOW_MS + 1, lockedUntil: null },
  ];
  db.insert(loginAttempts).values(rows).run();
  assert.equal(pruneLoginAttempts(db, now), 3);
  const left = db.select({ username: loginAttempts.username }).from(loginAttempts).all().map((row) => row.username);
  assert.deepEqual(left.sort(), ["in-window", "still-locked"]);
});
