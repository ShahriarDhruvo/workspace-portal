import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditLog, energyRates, hostDaily, openDatabase, users } from "@portal/db";
import { energyPriceSchema, isDay, isMonth, loadEnergyMonth, priceDay, priceOn, saveEnergyPrice, totalOf, type EnergyPrice } from "./energy.ts";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-energy-"));
  return openDatabase(path.join(dir, "portal.sqlite"));
}

/** Local noon on a day, so the local day is that day in any time zone. */
const noon = (day: string) => new Date(`${day}T12:00:00`);

const JANUARY: EnergyPrice = { effectiveFrom: "2026-01-01", centsPerKwh: 16.305, note: null };
const AUGUST: EnergyPrice = { effectiveFrom: "2026-08-01", centsPerKwh: 14.258, note: null };
const PRICES = [JANUARY, AUGUST];

test("the price in force is the latest that starts on or before the day", () => {
  assert.equal(priceOn(PRICES, "2025-12-31"), null);
  assert.equal(priceOn(PRICES, "2026-01-01")?.centsPerKwh, 16.305);
  assert.equal(priceOn(PRICES, "2026-07-31")?.centsPerKwh, 16.305);
  assert.equal(priceOn(PRICES, "2026-08-01")?.centsPerKwh, 14.258);
  assert.equal(priceOn(PRICES, "2026-11-16")?.centsPerKwh, 14.258);
});

test("a day adds up the servers that could be measured and prices them", () => {
  const day = priceDay("2026-11-16", [{ role: "llm", energyWh: 300 }, { role: "portal", energyWh: 20 }], AUGUST);
  assert.equal(day.llmKwh, 0.3);
  assert.equal(day.portalKwh, 0.02);
  assert.ok(Math.abs((day.kwh ?? 0) - 0.32) < 1e-12);
  assert.ok(Math.abs((day.usd ?? 0) - 0.32 * 0.14258) < 1e-12);

  const unmeasured = priceDay("2026-11-16", [{ role: "llm", energyWh: null }, { role: "portal", energyWh: 20 }], AUGUST);
  assert.equal(unmeasured.llmKwh, null);
  assert.equal(unmeasured.kwh, 0.02);

  const nothing = priceDay("2026-11-16", [{ role: "llm", energyWh: null }], AUGUST);
  assert.deepEqual([nothing.kwh, nothing.usd], [null, null]);

  const unpriced = priceDay("2020-01-01", [{ role: "llm", energyWh: 1000 }], null);
  assert.deepEqual([unpriced.kwh, unpriced.centsPerKwh, unpriced.usd], [1, null, null]);

  assert.deepEqual(totalOf([]), { kwh: null, usd: null });
  assert.deepEqual(totalOf([unpriced, unpriced]), { kwh: 2, usd: null });
});

test("months and days from URLs are checked", () => {
  assert.ok(isMonth("2026-11"));
  assert.ok(!isMonth("2026-13"));
  assert.ok(!isMonth("2026-1"));
  assert.ok(!isMonth(null));
  assert.ok(isDay("2028-02-29"));
  assert.ok(!isDay("2026-02-29"));
  assert.ok(!isDay("2026-11-16T00:00"));
});

test("a month: its days newest first, each at its own price, its total, today and the months there are", () => {
  const db = tempDb();
  const row = (day: string, role: "llm" | "portal", energyWh: number | null) => ({ day, role, energyWh, rxBytes: 0, txBytes: 0, updatedAt: 0 });
  db.insert(hostDaily)
    .values([
      row("2026-07-31", "llm", 1000),
      row("2026-07-31", "portal", null),
      row("2026-08-01", "llm", 1000),
      row("2026-08-01", "portal", 500),
      row("2026-08-02", "llm", null),
      row("2026-08-02", "portal", null),
      row("2026-11-16", "llm", 200),
    ])
    .run();

  const august = loadEnergyMonth(db, "2026-08", noon("2026-11-16"));
  assert.equal(august.month, "2026-08");
  assert.deepEqual(august.days.map((d) => d.day), ["2026-08-02", "2026-08-01"]);
  assert.equal(august.days[1]?.centsPerKwh, 14.258);
  assert.equal(august.days[0]?.kwh, null);
  assert.equal(august.total.kwh, 1.5);
  assert.ok(Math.abs((august.total.usd ?? 0) - 1.5 * 0.14258) < 1e-12);
  assert.equal(august.today, "2026-11-16");
  assert.equal(august.todayTotal.kwh, 0.2, "today, though another month is shown");
  assert.deepEqual(august.months, ["2026-11", "2026-08", "2026-07"]);
  assert.equal(august.price?.centsPerKwh, 14.258);
  assert.equal(august.prices[0]?.effectiveFrom, "2026-08-01", "prices newest first");

  const july = loadEnergyMonth(db, "2026-07", noon("2026-11-16"));
  assert.equal(july.days[0]?.centsPerKwh, 16.305, "July is priced at July's price");

  const fallback = loadEnergyMonth(db, "nonsense", noon("2026-12-02"));
  assert.equal(fallback.month, "2026-12");
  assert.deepEqual(fallback.days, []);
  assert.deepEqual(fallback.total, { kwh: null, usd: null });
  assert.deepEqual(fallback.months.slice(0, 2), ["2026-12", "2026-11"], "the current month even before its first reading");
});

test("the price form wants a real day and a price, to a thousandth of a cent", () => {
  const ok = energyPriceSchema.safeParse({ effectiveFrom: "2027-01-01", centsPerKwh: " 15.12345 ", note: " " });
  assert.ok(ok.success);
  assert.deepEqual(ok.data, { effectiveFrom: "2027-01-01", centsPerKwh: 15.123, note: null });
  for (const bad of [
    { effectiveFrom: "2027-02-30", centsPerKwh: "15", note: "" },
    { effectiveFrom: "2027-01-01", centsPerKwh: "", note: "" },
    { effectiveFrom: "2027-01-01", centsPerKwh: "abc", note: "" },
    { effectiveFrom: "2027-01-01", centsPerKwh: "-1", note: "" },
    { effectiveFrom: "2027-01-01", centsPerKwh: "15", note: "x".repeat(121) },
  ]) {
    assert.ok(!energyPriceSchema.safeParse(bad).success, JSON.stringify(bad));
  }
});

test("a new price is saved and audited; one for the same day replaces it", () => {
  const db = tempDb();
  const admin = db
    .insert(users)
    .values({ username: "admin", firstName: "A", lastName: "B", passwordHash: "x", role: "admin", createdAt: 0, updatedAt: 0 })
    .returning()
    .get();
  saveEnergyPrice(db, { effectiveFrom: "2027-01-01", centsPerKwh: 15, note: "TECO 2027" }, admin.id, 1000);
  saveEnergyPrice(db, { effectiveFrom: "2027-01-01", centsPerKwh: 15.5, note: null }, admin.id, 2000);
  const prices = db.select().from(energyRates).all().filter((rate) => rate.effectiveFrom === "2027-01-01");
  assert.equal(prices.length, 1);
  assert.equal(prices[0]?.centsPerKwh, 15.5);
  assert.equal(prices[0]?.note, null);
  const audit = db.select().from(auditLog).all().filter((entry) => entry.action === "energy_rate_set");
  assert.equal(audit.length, 2);
  assert.deepEqual(JSON.parse(audit[0]?.details ?? "null"), { effectiveFrom: "2027-01-01", price: "15 ¢/kWh", note: "TECO 2027" });
  assert.deepEqual(JSON.parse(audit[1]?.details ?? "null"), { effectiveFrom: "2027-01-01", price: { from: "15 ¢/kWh", to: "15.5 ¢/kWh" } });
  assert.equal(audit[1]?.actorUserId, admin.id);
});
