#!/usr/bin/env node
// Sets a new password on the admin account and signs the admin out everywhere.
//
//   node scripts/reset-admin-password.mjs [new-password]
//
// Without an argument it generates a temporary password, prints it, and the admin must choose a new
// one at the next sign-in. It also clears any sign-in lockout on the admin username. Reads the
// database at $PORTAL_DATA_DIR/db/portal.sqlite (default /srv/workspace-portal). In the container:
//
//   docker compose exec web node scripts/reset-admin-password.mjs
//
// Plain Node with only better-sqlite3 and @node-rs/argon2, so it runs from the standalone build.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { hash } from "@node-rs/argon2";
import Database from "better-sqlite3";

const MIN_LENGTH = 8;
const MAX_LENGTH = 256;
// Same shape as the portal's temporary passwords: 3 groups of 4, no look-alike characters.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePassword() {
  const chars = [];
  while (chars.length < 12) {
    const index = crypto.randomInt(ALPHABET.length);
    chars.push(ALPHABET[index]);
  }
  return [0, 4, 8].map((start) => chars.slice(start, start + 4).join("")).join("-");
}

function fail(message) {
  console.error(`reset-admin-password: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length > 1 || args[0] === "-h" || args[0] === "--help") {
  console.error("Usage: node scripts/reset-admin-password.mjs [new-password]");
  process.exit(args.length > 1 ? 1 : 0);
}

const given = args[0];
if (given !== undefined && (given.length < MIN_LENGTH || given.length > MAX_LENGTH)) {
  fail(`the password must be ${MIN_LENGTH}–${MAX_LENGTH} characters.`);
}
const password = given ?? generatePassword();

const dataDir = process.env.PORTAL_DATA_DIR?.trim() || "/srv/workspace-portal";
const dbFile = path.join(dataDir, "db", "portal.sqlite");
if (!fs.existsSync(dbFile)) fail(`no database at ${dbFile}. Set PORTAL_DATA_DIR, or start the portal once first.`);

const db = new Database(dbFile, { fileMustExist: true });
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

const admin = db.prepare("SELECT id, username FROM users WHERE role = 'admin'").get();
if (!admin) fail("there is no admin account yet. Set ADMIN_PASSWORD and start the portal to create it.");

const passwordHash = await hash(password);
const now = Date.now();
const signedOut = db.transaction(() => {
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?").run(
    passwordHash,
    given === undefined ? 1 : 0,
    now,
    admin.id,
  );
  const { changes } = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(admin.id);
  db.prepare("DELETE FROM login_attempts WHERE username = ?").run(admin.username);
  db.prepare("INSERT INTO audit_log (at, actor_user_id, action, target_user_id, details) VALUES (?, NULL, ?, ?, ?)").run(
    now,
    "password_reset",
    admin.id,
    JSON.stringify({ username: admin.username, source: "reset-admin-password" }),
  );
  return changes;
})();
db.close();

console.log(`Password reset for the admin account "${admin.username}". Signed out ${signedOut} session(s).`);
if (given === undefined) {
  console.log(`Temporary password: ${password}`);
  console.log("You will be asked to choose a new password after signing in.");
}
