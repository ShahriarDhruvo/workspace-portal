import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase, openForOwnershipChange, migrate } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";
import { eq } from "drizzle-orm";
import { energyPrices, hostDaily, portalSettings, users, sessions, workspaceSessions } from "./schema.ts";
import { readSetting, writeSetting } from "./settings.ts";
import { ENERGY_LOCATIONS, energyLocation, energyLocationLabel } from "./wire/index.ts";
import { countSessionsUsingWorkspace, hashSessionToken, loadSessionContext, readCookie } from "./sessions.ts";
import { usageDay } from "./usage-day.ts";

test("usageDay is the local calendar day, zero-padded", () => {
  assert.equal(usageDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(usageDay(new Date(2026, 10, 18, 0, 1)), "2026-11-18");
});

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
  assert.equal(db.$client.pragma("user_version", { simple: true }), MIGRATIONS.length);
});

test("a workspace's agent and kind, and a user's Online permission, take only known values", () => {
  const client = tempDb().$client;
  client.exec(`INSERT INTO users (username, first_name, last_name, password_hash, role, created_at, updated_at)
               VALUES ('a', 'A', 'A', 'x', 'user', 0, 0)`);
  client.exec(`INSERT INTO workspaces (user_id, status, started_at, updated_at) VALUES (1, 'stopped', 5, 0)`);
  assert.deepEqual(client.prepare("SELECT agent, kind FROM workspaces").get(), { agent: null, kind: "private" });
  assert.deepEqual(client.prepare("SELECT online_allowed FROM users").get(), { online_allowed: 1 });
  assert.throws(() => client.exec("UPDATE workspaces SET agent = 'other'"), /CHECK/);
  assert.throws(() => client.exec("UPDATE workspaces SET kind = 'public'"), /CHECK/);
  assert.throws(() => client.exec("UPDATE users SET online_allowed = 2"), /CHECK/);
});

test("the migration that admits OpenCode keeps every row, the other tables' rows and the indexes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-db-"));
  const client = new Database(path.join(dir, "old.sqlite"));
  client.pragma("foreign_keys = ON");
  // A database as the release before OpenCode left it.
  for (const sql of MIGRATIONS.slice(0, 2)) client.exec(sql);
  client.pragma("user_version = 2");
  client.exec(`
    INSERT INTO users (username, first_name, last_name, password_hash, role, created_at, updated_at, agent, online_allowed)
      VALUES ('root', 'R', 'R', 'x', 'admin', 1, 2, NULL, 1), ('ann', 'A', 'A', 'y', 'user', 3, 4, 'dsh', 0);
    INSERT INTO sessions (id, user_id, acting_as_user_id, created_at, last_seen_at, expires_at) VALUES ('s', 1, 2, 0, 0, 9);
    INSERT INTO workspaces (user_id, status, updated_at, agent, kind) VALUES (2, 'running', 5, 'qwen', 'online');
    INSERT INTO workspace_sessions (user_id, kind, agent, started_at, ended_at, requests) VALUES (2, 'online', 'qwen', 6, NULL, 7), (2, 'private', 'dsh', 1, 2, 0);
    INSERT INTO api_keys (user_id, name, token_hash, hint, created_at) VALUES (2, 'k', 'h', 'abcd', 0);
    INSERT INTO llm_usage (user_id, day, requests) VALUES (2, '2026-11-01', 3);
  `);

  migrate(client);
  assert.equal(client.pragma("user_version", { simple: true }), MIGRATIONS.length);
  assert.deepEqual(client.pragma("foreign_key_check"), []);
  assert.deepEqual(client.prepare("SELECT id, username, role, agent, online_allowed, created_at FROM users ORDER BY id").all(), [
    { id: 1, username: "root", role: "admin", agent: null, online_allowed: 1, created_at: 1 },
    { id: 2, username: "ann", role: "user", agent: "dsh", online_allowed: 0, created_at: 3 },
  ]);
  assert.deepEqual(client.prepare("SELECT user_id, status, agent, kind FROM workspaces").all(), [{ user_id: 2, status: "running", agent: "qwen", kind: "online" }]);
  assert.deepEqual(client.prepare("SELECT kind, agent, started_at, ended_at, requests FROM workspace_sessions ORDER BY id").all(), [
    { kind: "online", agent: "qwen", started_at: 6, ended_at: null, requests: 7 },
    { kind: "private", agent: "dsh", started_at: 1, ended_at: 2, requests: 0 },
  ]);
  // Nothing that hangs on a user went with the column.
  const count = (table: string): number => (client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  for (const table of ["sessions", "api_keys", "llm_usage"]) assert.equal(count(table), 1, table);

  for (const table of ["users", "workspaces", "workspace_sessions"]) {
    client.exec(`UPDATE ${table} SET agent = 'opencode'`);
    assert.throws(() => client.exec(`UPDATE ${table} SET agent = 'other'`), /CHECK/, table);
    assert.deepEqual(client.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name LIKE 'agent%'`).all(), [{ name: "agent" }]);
  }
  // The rules the indexes keep still hold: one admin, one open session per user.
  assert.throws(() => client.exec("UPDATE users SET role = 'admin' WHERE id = 2"), /UNIQUE/);
  assert.throws(() => client.exec("INSERT INTO workspace_sessions (user_id, kind, started_at) VALUES (2, 'private', 9)"), /UNIQUE/);
  client.exec("DELETE FROM users WHERE id = 2");
  assert.equal(count("workspaces"), 0, "a user's rows still go with the user");
  client.close();
});

test("one host_daily row per day and server", () => {
  const db = tempDb();
  db.insert(hostDaily).values({ day: "2026-11-16", role: "llm", energyWh: null, updatedAt: 1 }).run();
  assert.throws(() => db.insert(hostDaily).values({ day: "2026-11-16", role: "llm", updatedAt: 2 }).run(), /UNIQUE/);
  assert.throws(() => db.insert(hostDaily).values({ day: "2026-11-16", role: "other" as "llm", updatedAt: 2 }).run(), /CHECK/);
  assert.throws(() => db.insert(hostDaily).values({ day: "16/11/2026", role: "portal", updatedAt: 2 }).run(), /CHECK/);
  assert.deepEqual(db.select().from(hostDaily).all(), [{ day: "2026-11-16", role: "llm", energyWh: null, rxBytes: 0, txBytes: 0, updatedAt: 1 }]);
});

test("published prices per place and period, and portal settings", () => {
  const db = tempDb();
  const row = { location: "US-FL", periodStart: "2026-08-01", periodEnd: "2026-09-01", period: "2026-08", price: 0.1499, currency: "USD", source: "eia", fetchedAt: 1 } as const;
  db.insert(energyPrices).values(row).run();
  assert.throws(() => db.insert(energyPrices).values(row).run(), /UNIQUE/);
  for (const bad of [
    { location: "Florida" },
    { periodStart: "2026-08-02" },
    { periodEnd: "2026-07-01" },
    { periodEnd: "2026-08-15" },
    { period: "August 2026" },
    { price: 0 },
    { currency: "GBP" },
    { source: "teco" },
  ]) {
    assert.throws(() => db.insert(energyPrices).values({ ...row, periodStart: "2026-07-01", periodEnd: "2026-08-01", period: "2026-07", ...bad } as typeof energyPrices.$inferInsert).run(), /CHECK/, JSON.stringify(bad));
  }
  db.insert(energyPrices).values({ ...row, location: "EU-DE", periodStart: "2026-01-01", periodEnd: "2026-07-01", period: "2026-S1", price: 0.3618, currency: "EUR", source: "eurostat" }).run();

  assert.equal(readSetting(db, "energy_price_location"), null, "no place until the admin picks one");
  writeSetting(db, "energy_price_location", "US-FL", 5);
  writeSetting(db, "energy_price_location", "EU-DE", 6);
  assert.deepEqual(db.select().from(portalSettings).all(), [{ key: "energy_price_location", value: "EU-DE", updatedAt: 6 }]);
  assert.equal(readSetting(db, "energy_price_location"), "EU-DE");
  writeSetting(db, "energy_price_location", null);
  assert.equal(readSetting(db, "energy_price_location"), null);
});

test("workspace sessions: one open per user, gone with their user", () => {
  const db = tempDb();
  const userId = addUser(db, "ana").id;
  const open = { userId, kind: "private", agent: "qwen", startedAt: 1 } as const;
  db.insert(workspaceSessions).values({ ...open, endedAt: 5 }).run();
  const id = db.insert(workspaceSessions).values(open).returning({ id: workspaceSessions.id }).get().id;
  assert.throws(() => db.insert(workspaceSessions).values({ ...open, kind: "online", startedAt: 6 }).run(), /UNIQUE/, "one open session per user");
  const row = db.select().from(workspaceSessions).where(eq(workspaceSessions.id, id)).get()!;
  assert.deepEqual([row.requests, row.promptTokens, row.llmMs, row.energyJ, row.energyMs], [0, 0, 0, null, 0], "nothing counted yet");
  assert.throws(() => db.insert(workspaceSessions).values({ ...open, kind: "shared" } as unknown as typeof workspaceSessions.$inferInsert).run(), /CHECK/);
  db.delete(users).where(eq(users.id, userId)).run();
  assert.equal(db.select().from(workspaceSessions).all().length, 0);
});

test("energy locations: the 50 states and DC, Eurostat's countries, unique ids, a label that tells the two Georgias apart", () => {
  assert.equal(ENERGY_LOCATIONS.filter((location) => location.region === "us").length, 51);
  assert.ok(ENERGY_LOCATIONS.filter((location) => location.region === "europe").length >= 35);
  assert.equal(new Set(ENERGY_LOCATIONS.map((location) => location.id)).size, ENERGY_LOCATIONS.length);
  assert.ok(ENERGY_LOCATIONS.every((location) => /^(US|EU)-[A-Z]{2}$/.test(location.id)));
  assert.deepEqual(energyLocation("US-FL"), { id: "US-FL", region: "us", code: "FL", name: "Florida", source: "eia", currency: "USD" });
  assert.deepEqual(energyLocation("EU-EL"), { id: "EU-EL", region: "europe", code: "EL", name: "Greece", source: "eurostat", currency: "EUR" });
  assert.equal(energyLocation("EU-UK"), null);
  assert.equal(energyLocation(null), null);
  assert.equal(energyLocationLabel(energyLocation("US-GA")!), "Georgia, US");
  assert.equal(energyLocationLabel(energyLocation("EU-GE")!), "Georgia");
  const us = ENERGY_LOCATIONS.filter((location) => location.region === "us").map((location) => location.name);
  assert.deepEqual(us, [...us].sort((a, b) => a.localeCompare(b, "en")), "A to Z");
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
  const token = agentBrowserToken("s".repeat(32), "session-a", 7, "private");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token, agentBrowserToken("s".repeat(32), "session-a", 7, "private"));
  assert.notEqual(token, agentBrowserToken("s".repeat(32), "session-b", 7, "private"));
  assert.notEqual(token, agentBrowserToken("s".repeat(32), "session-a", 8, "private"));
  assert.notEqual(token, agentBrowserToken("t".repeat(32), "session-a", 7, "private"));
  // A user's two kinds are separate origins with separate tokens.
  assert.notEqual(token, agentBrowserToken("s".repeat(32), "session-a", 7, "online"));
  assert.ok(tokensEqual(token, token));
  assert.ok(!tokensEqual(token, token.slice(1)));
});

test("ownership changes refuse symlinks, hard links and non-files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-chown-"));
  const file = path.join(dir, "portal.sqlite");
  fs.writeFileSync(file, "");

  const fd = openForOwnershipChange(file);
  assert.equal(typeof fd, "number", "a plain file with one link is opened");
  fs.closeSync(fd!);
  assert.equal(openForOwnershipChange(`${file}-shm`), null, "a missing file is skipped");

  // What a compromised web process could plant for the root gateway to chown.
  const outside = path.join(dir, "docker.sock");
  fs.writeFileSync(outside, "");
  fs.symlinkSync(outside, `${file}-wal`);
  assert.throws(() => openForOwnershipChange(`${file}-wal`), /symbolic link/);
  fs.symlinkSync(path.join(dir, "missing"), `${file}-dangling`);
  assert.throws(() => openForOwnershipChange(`${file}-dangling`), /symbolic link/);

  fs.linkSync(outside, `${file}-shm`);
  assert.throws(() => openForOwnershipChange(`${file}-shm`), /2 hard links/);
  assert.throws(() => openForOwnershipChange(outside), /2 hard links/, "the link target is refused too");

  fs.mkdirSync(`${file}-dir`);
  assert.throws(() => openForOwnershipChange(`${file}-dir`), /not a regular file/);
  // A FIFO would block a plain open forever; it must be refused at once.
  execFileSync("mkfifo", [`${file}-fifo`]);
  assert.throws(() => openForOwnershipChange(`${file}-fifo`), /not a regular file/);
  fs.rmSync(dir, { recursive: true, force: true });
});
