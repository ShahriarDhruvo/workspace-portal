import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { hashSessionToken, openDatabase, sessions, users } from "@portal/db";
import { deleteSessions, pruneExpiredSessions } from "./session-store.ts";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sessions-"));
  return { db: openDatabase(path.join(dir, "test.sqlite")), dir };
}

type Db = ReturnType<typeof tempDb>["db"];

function addUser(db: Db, username: string, role: "admin" | "user" = "user") {
  const now = Date.now();
  return db
    .insert(users)
    .values({ username, firstName: "F", lastName: "L", passwordHash: "x", role, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

function addSession(db: Db, token: string, userId: number, options: { actingAs?: number; expiresAt?: number } = {}) {
  const now = Date.now();
  const id = hashSessionToken(token);
  db.insert(sessions)
    .values({ id, userId, actingAsUserId: options.actingAs ?? null, createdAt: now, lastSeenAt: now, expiresAt: options.expiresAt ?? now + 60_000 })
    .run();
  return id;
}

test("deleteSessions returns the deleted session ids and the workspaces they used", () => {
  const { db, dir } = tempDb();
  const admin = addUser(db, "admin", "admin");
  const alice = addUser(db, "alice");
  const bob = addUser(db, "bob");
  const own = addSession(db, "admin-own", admin.id);
  const viewing = addSession(db, "admin-viewing", admin.id, { actingAs: alice.id });
  const bobs = [addSession(db, "bob-1", bob.id), addSession(db, "bob-2", bob.id)];

  const deletedAdmin = deleteSessions(db, eq(sessions.userId, admin.id));
  assert.deepEqual(new Set(deletedAdmin.sessionIds), new Set([own, viewing]));
  assert.deepEqual(new Set(deletedAdmin.workspaceUserIds), new Set([admin.id, alice.id]), "a viewing session used the viewed workspace");

  const deletedBob = deleteSessions(db, eq(sessions.userId, bob.id));
  assert.deepEqual(new Set(deletedBob.sessionIds), new Set(bobs));
  assert.deepEqual(deletedBob.workspaceUserIds, [bob.id], "each workspace is listed once");

  assert.deepEqual(deleteSessions(db, eq(sessions.userId, bob.id)), { sessionIds: [], workspaceUserIds: [] });
  assert.equal(db.select().from(sessions).all().length, 0);
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pruneExpiredSessions deletes only expired sessions", () => {
  const { db, dir } = tempDb();
  const alice = addUser(db, "alice");
  const now = 10_000_000;
  const expired = addSession(db, "old", alice.id, { expiresAt: now - 1 });
  const atNow = addSession(db, "now", alice.id, { expiresAt: now });
  const live = addSession(db, "live", alice.id, { expiresAt: now + 1 });

  const pruned = pruneExpiredSessions(db, now);
  assert.deepEqual(new Set(pruned.sessionIds), new Set([expired, atNow]));
  assert.deepEqual(pruned.workspaceUserIds, [alice.id]);
  assert.deepEqual(db.select({ id: sessions.id }).from(sessions).all(), [{ id: live }]);
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
