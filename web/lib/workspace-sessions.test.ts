import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { energyLocation, energyPrices, openDatabase, users, workspaceSessions } from "@portal/core";
import { saveEnergyLocation } from "./energy.ts";
import { SESSION_PAGE_SIZE } from "./session-types.ts";
import { loadSessionPage, sessionRow } from "./workspace-sessions.ts";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sessions-"));
  return openDatabase(path.join(dir, "portal.sqlite"));
}

const at = (day: string) => new Date(`${day}T12:00:00`).getTime();

const stored = {
  id: 1,
  userId: 2,
  kind: "online" as const,
  agent: "qwen" as const,
  startedAt: at("2026-08-10"),
  endedAt: null,
  requests: 3,
  failed: 1,
  promptTokens: 9000,
  outputTokens: 300,
  cachedTokens: 6000,
  readTokens: 3000,
  readMs: 5000,
  writeTokens: 300,
  writeMs: 6000,
  llmMs: 20_000,
  energyJ: 3600,
  energyMs: 30_000,
};

test("a session's rates, energy, draw and cost come from its sums", () => {
  const row = sessionRow(stored, "Ana", { price: 0.15, period: "2026-08", estimate: false });
  assert.equal(row.readTps, 600);
  assert.equal(row.writeTps, 50);
  assert.equal(row.energyWh, 1);
  assert.equal(row.watts, 120);
  assert.ok(Math.abs(row.cost! - 0.00015) < 1e-12);
  assert.equal(row.costEstimate, false);
  assert.equal(row.tokensIn, 9000);
  assert.equal(row.userName, "Ana");
});

test("no requests or no measured energy: no rates, energy or cost", () => {
  const none = sessionRow({ ...stored, readMs: 0, writeMs: 0, energyJ: null, energyMs: 0 }, "Ana", { price: 0.15, period: "2026-08", estimate: true });
  assert.deepEqual([none.readTps, none.writeTps, none.energyWh, none.watts, none.cost, none.costEstimate], [null, null, null, null, null, false]);
  const unpriced = sessionRow(stored, "Ana", null);
  assert.equal(unpriced.cost, null);
  assert.equal(sessionRow(stored, "Ana", { price: 0.15, period: "2026-07", estimate: true }).costEstimate, true);
});

test("pages: the running sessions first, then the ended ones by when they ended; costs at the chosen place", () => {
  const db = tempDb();
  const user = (username: string, firstName: string, role: "admin" | "user") =>
    db.insert(users).values({ username, firstName, lastName: "", passwordHash: "x", role, createdAt: 0, updatedAt: 0 }).returning().get();
  const ana = user("ana", "Ana", "admin");
  const bo = user("bo", "Bo", "user");
  const session = (userId: number, startedAt: number, endedAt: number | null) =>
    db.insert(workspaceSessions).values({ userId, kind: "private", startedAt, endedAt, energyJ: 3_600_000, energyMs: 3_600_000 }).run();
  for (let i = 0; i < SESSION_PAGE_SIZE + 2; i++) session(ana.id, at("2026-08-01") + i * 60_000, at("2026-08-01") + i * 60_000 + 1000);
  session(bo.id, at("2026-07-01"), null);

  const first = loadSessionPage(db, 1);
  assert.equal(first.total, SESSION_PAGE_SIZE + 3);
  assert.equal(first.rows.length, SESSION_PAGE_SIZE);
  assert.equal(first.rows[0]?.userName, "Bo");
  assert.equal(first.rows[0]?.endedAt, null);
  assert.ok((first.rows[1]?.endedAt ?? 0) > (first.rows[2]?.endedAt ?? 0));
  assert.equal(first.currency, null);
  assert.equal(first.rows[0]?.cost, null);
  assert.equal(loadSessionPage(db, 99).page, 2);
  assert.equal(loadSessionPage(db, 2).rows.length, 3);

  saveEnergyLocation(db, energyLocation("US-FL")!, ana.id, 1);
  db.insert(energyPrices)
    .values({ location: "US-FL", periodStart: "2026-07-01", periodEnd: "2026-08-01", period: "2026-07", price: 0.2, currency: "USD", source: "eia", fetchedAt: 1 })
    .run();
  const priced = loadSessionPage(db, 1);
  assert.equal(priced.currency, "USD");
  assert.equal(priced.rows[0]?.cost, 0.2);
  assert.equal(priced.rows[0]?.costEstimate, false);
  // August has no price of its own yet: July's stands in.
  assert.equal(priced.rows[1]?.cost, 0.2);
  assert.equal(priced.rows[1]?.costEstimate, true);
});
