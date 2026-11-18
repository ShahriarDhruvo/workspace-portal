// config.ts can't be imported here ("server-only" resolves only inside Next's compilers), so its fallbacks are read
// from the source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const read = (...file: string[]) => fs.readFileSync(path.join(import.meta.dirname, "..", ...file), "utf8");

test("the settings fall back to .env.example's values", () => {
  const example = Object.fromEntries(Array.from(read("..", ".env.example").matchAll(/^([A-Z0-9_]+)=(.*)$/gm), ([, key, value]) => [key, value]));
  const fallbacks = Array.from(read("lib", "config.ts").matchAll(/\b(?:text|positiveInt)\("([A-Z_]+)", "?([\w/-]+)"?\)/g), ([, key, value]) => [key!, value!] as const);
  assert.deepEqual(fallbacks.map(([key]) => key).sort(), ["ADMIN_FIRST_NAME", "ADMIN_LAST_NAME", "ADMIN_USERNAME", "AGENT_PORT_BASE", "AGENT_PORT_COUNT", "CONTROL_PORT", "IDLE_TIMEOUT_MINUTES", "PORTAL_DATA_DIR", "SESSION_TTL_HOURS"]);
  for (const [key, value] of fallbacks) assert.equal(value, example[key], key);
  assert.equal(example.ONLINE_AGENT_PORT_BASE, "", "derived: AGENT_PORT_BASE + AGENT_PORT_COUNT");
  assert.equal(example.PORTAL_HTTPS, "false");
  assert.ok(read("scripts", "reset-admin-password.mjs").includes(`PORTAL_DATA_DIR?.trim() || "${example.PORTAL_DATA_DIR}"`), "reset-admin-password.mjs");
});
