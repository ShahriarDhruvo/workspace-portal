import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { auditLog, openDatabase, users } from "@portal/db";
import { verifyPassword } from "./passwords.ts";
import { seedAdmin, type AdminSeedSettings } from "./seed.ts";

const SETTINGS: AdminSeedSettings = {
  username: "Admin",
  password: "seed-pass-123",
  firstName: "Portal",
  middleName: "",
  lastName: "Admin",
};

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-seed-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  return {
    db,
    [Symbol.dispose]() {
      db.$client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** seedAdmin reports problems on the console; keep test output clean and let tests read them. */
async function quietly(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const { log, error } = console;
  console.log = console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, { log, error });
  }
  return lines;
}

test("seedAdmin creates the admin, who must change the generated password at the first sign-in", async () => {
  using t = tempDb();
  const { db } = t;
  await quietly(() => seedAdmin(db, SETTINGS));
  const admin = db.select().from(users).where(eq(users.role, "admin")).get();
  assert.ok(admin);
  assert.equal(admin.username, "admin", "stored lowercase");
  assert.equal(admin.mustChangePassword, true);
  assert.equal(admin.middleName, null);
  assert.ok(await verifyPassword(admin.passwordHash, SETTINGS.password));
  const audit = db.select().from(auditLog).all();
  assert.deepEqual(
    audit.map((entry) => [entry.action, entry.actorUserId, entry.targetUserId]),
    [["user_created", null, admin.id]],
  );
});

test("seedAdmin never touches an existing admin", async () => {
  using t = tempDb();
  const { db } = t;
  await quietly(() => seedAdmin(db, SETTINGS));
  const first = db.select().from(users).where(eq(users.role, "admin")).get()!;
  db.update(users).set({ mustChangePassword: false }).where(eq(users.id, first.id)).run();
  await quietly(() => seedAdmin(db, { ...SETTINGS, username: "other", password: "another-pass-1" }));
  assert.deepEqual(db.select().from(users).all(), [{ ...first, mustChangePassword: false }]);
});

test("seedAdmin creates nothing without a password or with invalid settings", async () => {
  using t = tempDb();
  const { db } = t;
  const empty = await quietly(() => seedAdmin(db, { ...SETTINGS, password: "" }));
  assert.match(empty.join("\n"), /ADMIN_PASSWORD is empty/);
  const invalid = await quietly(() => seedAdmin(db, { ...SETTINGS, username: "x", password: "short" }));
  assert.match(invalid.join("\n"), /username: .*password: /);
  assert.equal(db.select().from(users).all().length, 0);
});
