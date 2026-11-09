import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "@portal/db";
import {
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
  MAX_FAILURES,
  clearLoginFailures,
  lockRemaining,
  lockoutMessage,
  loginLockRemaining,
  nextFailureState,
  recordLoginFailure,
  type AttemptState,
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

test("database-backed throttle locks, reports and clears per username", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-throttle-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  const now = 5_000_000;
  for (let i = 0; i < MAX_FAILURES - 1; i++) recordLoginFailure(db, "alice", now + i);
  assert.equal(loginLockRemaining(db, "alice", now + 10), 0);
  const state = recordLoginFailure(db, "alice", now + 10);
  assert.equal(state.failures, MAX_FAILURES);
  assert.equal(loginLockRemaining(db, "alice", now + 10), LOCKOUT_MS);
  assert.equal(loginLockRemaining(db, "bob", now + 10), 0, "other usernames are unaffected");
  clearLoginFailures(db, "alice");
  assert.equal(loginLockRemaining(db, "alice", now + 10), 0);
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
