import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "./db.ts";
import { users, sessions } from "./schema.ts";
import { countSessionsUsingWorkspace, hashSessionToken, loadSessionContext, readCookie } from "./sessions.ts";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-db-"));
  return openDatabase(path.join(dir, "test.sqlite"));
}

function addUser(db: ReturnType<typeof tempDb>, username: string, role: "admin" | "user" = "user", active = true) {
  const now = Date.now();
  return db
    .insert(users)
    .values({ username, firstName: "F", lastName: "L", passwordHash: "x", role, active, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

function addSession(db: ReturnType<typeof tempDb>, token: string, userId: number, actingAsUserId: number | null = null, ttl = 60_000) {
  const now = Date.now();
  db.insert(sessions)
    .values({ id: hashSessionToken(token), userId, actingAsUserId, createdAt: now, lastSeenAt: now, expiresAt: now + ttl })
    .run();
}

test("migrations are idempotent", () => {
  const db = tempDb();
  migrate(db.$client);
  migrate(db.$client);
  assert.equal(db.$client.pragma("user_version", { simple: true }), 1);
});

test("only one admin can exist", () => {
  const db = tempDb();
  addUser(db, "admin", "admin");
  assert.throws(() => addUser(db, "admin2", "admin"), /UNIQUE/);
  addUser(db, "alice");
  addUser(db, "bob");
});

test("session context resolves acting-as only for admins", () => {
  const db = tempDb();
  const admin = addUser(db, "admin", "admin");
  const alice = addUser(db, "alice");
  const bob = addUser(db, "bob");
  addSession(db, "t-admin", admin.id, alice.id);
  addSession(db, "t-bob", bob.id, alice.id); // a normal user can never act as someone else

  const a = loadSessionContext(db, hashSessionToken("t-admin"))!;
  assert.equal(a.user.id, admin.id);
  assert.equal(a.target.id, alice.id);
  assert.equal(a.actingAs, true);

  const b = loadSessionContext(db, hashSessionToken("t-bob"))!;
  assert.equal(b.target.id, bob.id);
  assert.equal(b.actingAs, false);
});

test("expired sessions and inactive users are rejected", () => {
  const db = tempDb();
  const carol = addUser(db, "carol", "user", false);
  const dave = addUser(db, "dave");
  addSession(db, "t-carol", carol.id);
  addSession(db, "t-dave", dave.id, null, -1);
  assert.equal(loadSessionContext(db, hashSessionToken("t-carol")), null);
  assert.equal(loadSessionContext(db, hashSessionToken("t-dave")), null);
});

test("countSessionsUsingWorkspace counts own sessions and admin viewers", () => {
  const db = tempDb();
  const admin = addUser(db, "admin", "admin");
  const alice = addUser(db, "alice");
  assert.equal(countSessionsUsingWorkspace(db, alice.id), 0);
  addSession(db, "a1", alice.id);
  assert.equal(countSessionsUsingWorkspace(db, alice.id), 1);
  addSession(db, "adm", admin.id, alice.id);
  assert.equal(countSessionsUsingWorkspace(db, alice.id), 2);
  // The admin's own workspace is not in use while that session views alice.
  assert.equal(countSessionsUsingWorkspace(db, admin.id), 0);
});

test("readCookie parses a header", () => {
  assert.equal(readCookie("a=1; portal_session=abc%2Bd; b=2", "portal_session"), "abc+d");
  assert.equal(readCookie("a=1", "portal_session"), null);
  assert.equal(readCookie(undefined, "x"), null);
});

test("agent ports map users to ports and back within the range", async () => {
  const { agentPortFor, userIdForAgentPort } = await import("./agent-origin.ts");
  assert.equal(agentPortFor(3100, 200, 7), 3107);
  assert.equal(agentPortFor(3100, 200, 0), null);
  assert.equal(agentPortFor(3100, 200, 200), null);
  assert.equal(userIdForAgentPort(3100, 200, 3107), 7);
  assert.equal(userIdForAgentPort(3100, 200, 3100), null);
  assert.equal(userIdForAgentPort(3100, 200, 3300), null);
});

test("agent browser tokens are bound to the session and the workspace", async () => {
  const { agentBrowserToken, tokensEqual } = await import("./agent-origin.ts");
  const token = agentBrowserToken("s".repeat(32), "session-a", 7);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token, agentBrowserToken("s".repeat(32), "session-a", 7));
  assert.notEqual(token, agentBrowserToken("s".repeat(32), "session-b", 7));
  assert.notEqual(token, agentBrowserToken("s".repeat(32), "session-a", 8));
  assert.notEqual(token, agentBrowserToken("t".repeat(32), "session-a", 7));
  assert.ok(tokensEqual(token, token));
  assert.ok(!tokensEqual(token, token.slice(1)));
});
