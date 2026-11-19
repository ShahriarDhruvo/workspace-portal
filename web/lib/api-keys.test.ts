import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { apiKeys, apiKeyUsage, auditLog, energyPrices, hashSessionToken, openDatabase, users, writeSetting } from "@portal/core";
import { createApiKey, loadApiKeys, revokeApiKey } from "./api-keys.ts";
import { MAX_API_KEYS } from "./limits.ts";

function setup() {
  const db = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portal-keys-")), "portal.sqlite"));
  const user = (username: string): number =>
    db.insert(users).values({ username, firstName: "A", lastName: "B", passwordHash: "x", createdAt: 1, updatedAt: 1 }).returning().get().id;
  return { db, ana: user("ana"), ben: user("ben") };
}

test("a key is made once, stored as its hash, and a user has at most five working ones", () => {
  const { db, ana, ben } = setup();
  const key = createApiKey(db, ana, "editor", 1_000)!;
  assert.match(key, /^sk-[0-9a-f]{48}$/);
  assert.deepEqual(db.select().from(apiKeys).all(), [
    { id: 1, userId: ana, name: "editor", tokenHash: hashSessionToken(key), hint: key.slice(-4), createdAt: 1_000, revokedAt: null },
  ]);
  for (let n = 2; n <= MAX_API_KEYS; n++) assert.notEqual(createApiKey(db, ana, `key ${n}`), key);
  assert.equal(createApiKey(db, ana, "one too many"), null);
  assert.notEqual(createApiKey(db, ben, "another user's"), null);

  assert.equal(revokeApiKey(db, ben, 1), false, "not another user's key");
  assert.equal(revokeApiKey(db, ana, 1, 2_000), true);
  assert.equal(revokeApiKey(db, ana, 1), false, "not twice");
  assert.equal(db.select().from(apiKeys).where(eq(apiKeys.id, 1)).get()!.revokedAt, 2_000);
  assert.notEqual(createApiKey(db, ana, "in its place"), null, "a revoked key leaves room for a new one");

  const audited = db.select().from(auditLog).all().filter((entry) => entry.actorUserId === ana);
  assert.deepEqual([audited[0]!.action, audited[0]!.details], ["api_key_created", '{"name":"editor"}']);
  assert.deepEqual([audited.at(-2)!.action, audited.at(-2)!.details], ["api_key_revoked", '{"name":"editor"}']);
});

test("each key's use in all and per day, at each day's price; a revoked key keeps its days", () => {
  const { db, ana, ben } = setup();
  createApiKey(db, ana, "editor", 1_000);
  createApiKey(db, ana, "script", 2_000);
  createApiKey(db, ana, "unused", 3_000);
  createApiKey(db, ben, "ben's");
  const use = (keyId: number, day: string, requests: number, energyJ: number) =>
    db.insert(apiKeyUsage).values({ keyId, day, requests, failed: requests - 1, promptTokens: 100 * requests, outputTokens: 10 * requests, energyJ }).run();
  use(1, "2026-07-31", 2, 3_600_000);
  use(1, "2026-11-18", 1, 7_200_000);
  use(2, "2026-11-18", 4, 0);
  use(4, "2026-11-18", 9, 3_600_000);
  revokeApiKey(db, ana, 2);

  const unpriced = loadApiKeys(db, ana);
  assert.equal(unpriced.currency, null);
  assert.deepEqual(unpriced.keys.map((key) => [key.name, key.cost]), [["editor", null], ["unused", null]]);

  writeSetting(db, "energy_price_location", "US-FL");
  for (const [periodStart, periodEnd, price] of [["2026-07-01", "2026-08-01", 0.15], ["2026-08-01", "2026-09-01", 0.2]] as const) {
    db.insert(energyPrices).values({ location: "US-FL", periodStart, periodEnd, period: periodStart.slice(0, 7), price, currency: "USD", source: "eia", fetchedAt: 1 }).run();
  }
  const view = loadApiKeys(db, ana);
  assert.equal(view.currency, "USD");
  // 1 kWh in July at its own price, 2 kWh in November at the latest published one.
  assert.deepEqual(view.keys, [
    { id: 1, name: "editor", hint: view.keys[0]!.hint, createdAt: 1_000, lastUsed: "2026-11-18", requests: 3, failed: 1, tokensIn: 300, tokensOut: 30, energyWh: 3_000, cost: 0.15 + 0.4, costEstimate: true },
    { id: 3, name: "unused", hint: view.keys[1]!.hint, createdAt: 3_000, lastUsed: null, requests: 0, failed: 0, tokensIn: 0, tokensOut: 0, energyWh: null, cost: null, costEstimate: false },
  ]);
  assert.deepEqual(
    view.days.map((day) => [day.day, day.name, day.revoked, day.requests, day.energyWh, day.cost, day.costEstimate]),
    [
      ["2026-11-18", "editor", false, 1, 2_000, 0.4, true],
      ["2026-11-18", "script", true, 4, null, null, false],
      ["2026-07-31", "editor", false, 2, 1_000, 0.15, false],
    ],
  );
});
