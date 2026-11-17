import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditLog, energyLocation, energyPrices, hostDaily, openDatabase, readSetting, users, writeSetting } from "@portal/core";
import { isMonth, loadEnergyLocation, loadEnergyMonth, loadPricePeriods, priceDay, priceOn, priceSummary, saveEnergyLocation, totalOf, type PricePeriod } from "./energy.ts";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-energy-"));
  return openDatabase(path.join(dir, "portal.sqlite"));
}

/** Local noon on a day, so the local day is that day in any time zone. */
const noon = (day: string) => new Date(`${day}T12:00:00`);

const JULY: PricePeriod = { periodStart: "2026-07-01", periodEnd: "2026-08-01", period: "2026-07", price: 0.1512 };
const AUGUST: PricePeriod = { periodStart: "2026-08-01", periodEnd: "2026-09-01", period: "2026-08", price: 0.1499 };
const PERIODS = [JULY, AUGUST];

test("a day's price: its own period's, else the latest published (an estimate), else the oldest (an estimate)", () => {
  assert.equal(priceOn([], "2026-08-15"), null);
  assert.deepEqual(priceOn(PERIODS, "2026-07-01"), { price: 0.1512, period: "2026-07", estimate: false });
  assert.deepEqual(priceOn(PERIODS, "2026-07-31"), { price: 0.1512, period: "2026-07", estimate: false });
  assert.deepEqual(priceOn(PERIODS, "2026-08-31"), { price: 0.1499, period: "2026-08", estimate: false });
  assert.deepEqual(priceOn(PERIODS, "2026-11-16"), { price: 0.1499, period: "2026-08", estimate: true }, "November isn't published yet");
  assert.deepEqual(priceOn(PERIODS, "2026-06-30"), { price: 0.1512, period: "2026-07", estimate: true }, "older than every period");
  const halves: PricePeriod[] = [{ periodStart: "2026-01-01", periodEnd: "2026-07-01", period: "2026-S1", price: 0.3618 }];
  assert.deepEqual(priceOn(halves, "2026-06-30"), { price: 0.3618, period: "2026-S1", estimate: false });
  assert.deepEqual(priceOn(halves, "2026-07-01"), { price: 0.3618, period: "2026-S1", estimate: true });
});

test("a day adds up the servers that could be measured and prices them", () => {
  const price = priceOn(PERIODS, "2026-08-16");
  const day = priceDay("2026-08-16", [{ role: "llm", energyWh: 300 }, { role: "portal", energyWh: 20 }], price);
  assert.equal(day.llmKwh, 0.3);
  assert.equal(day.portalKwh, 0.02);
  assert.ok(Math.abs((day.kwh ?? 0) - 0.32) < 1e-12);
  assert.ok(Math.abs((day.cost ?? 0) - 0.32 * 0.1499) < 1e-12);

  const unmeasured = priceDay("2026-08-16", [{ role: "llm", energyWh: null }, { role: "portal", energyWh: 20 }], price);
  assert.equal(unmeasured.llmKwh, null);
  assert.equal(unmeasured.kwh, 0.02);

  const nothing = priceDay("2026-08-16", [{ role: "llm", energyWh: null }], price);
  assert.deepEqual([nothing.kwh, nothing.cost], [null, null]);

  const unpriced = priceDay("2026-08-16", [{ role: "llm", energyWh: 1000 }], null);
  assert.deepEqual([unpriced.kwh, unpriced.price, unpriced.cost], [1, null, null]);

  assert.deepEqual(totalOf([]), { kwh: null, cost: null });
  assert.deepEqual(totalOf([unpriced, unpriced]), { kwh: 2, cost: null });
});

test("months from URLs are checked", () => {
  assert.ok(isMonth("2026-11"));
  assert.ok(!isMonth("2026-13"));
  assert.ok(!isMonth("2026-1"));
  assert.ok(!isMonth(null));
});

function seedMonth() {
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
  const price = (location: string, period: PricePeriod, currency: "USD" | "EUR", source: "eia" | "eurostat") => ({ location, ...period, currency, source, fetchedAt: 1 });
  db.insert(energyPrices)
    .values([
      price("US-FL", AUGUST, "USD", "eia"),
      price("US-FL", JULY, "USD", "eia"),
      price("US-TX", { ...AUGUST, price: 0.1601 }, "USD", "eia"),
      price("EU-DE", { periodStart: "2026-01-01", periodEnd: "2026-07-01", period: "2026-S1", price: 0.3618 }, "EUR", "eurostat"),
    ])
    .run();
  return db;
}

test("a month without a place picked: energy only, no prices or costs", () => {
  const db = seedMonth();
  const august = loadEnergyMonth(db, "2026-08", noon("2026-11-16"));
  assert.equal(august.location, null);
  assert.equal(august.price, null);
  assert.deepEqual(august.total, { kwh: 1.5, cost: null });
  assert.ok(august.days.every((day) => day.price === null && day.cost === null));
});

test("a month: its days newest first, each at its own month's price, its total, today and the months there are", () => {
  const db = seedMonth();
  writeSetting(db, "energy_price_location", "US-FL");

  const august = loadEnergyMonth(db, "2026-08", noon("2026-11-16"));
  assert.equal(august.month, "2026-08");
  assert.equal(august.location?.id, "US-FL");
  assert.equal(august.location?.currency, "USD");
  assert.deepEqual(august.days.map((d) => d.day), ["2026-08-02", "2026-08-01"]);
  assert.deepEqual(august.days[1]?.price, { price: 0.1499, period: "2026-08", estimate: false });
  assert.equal(august.days[0]?.kwh, null);
  assert.equal(august.total.kwh, 1.5);
  assert.ok(Math.abs((august.total.cost ?? 0) - 1.5 * 0.1499) < 1e-12);
  assert.equal(august.today, "2026-11-16");
  assert.equal(august.todayTotal.kwh, 0.2, "today, though another month is shown");
  assert.ok(Math.abs((august.todayTotal.cost ?? 0) - 0.2 * 0.1499) < 1e-12, "today at August's price, the latest published");
  assert.deepEqual(august.months, ["2026-11", "2026-08", "2026-07"]);
  assert.deepEqual(august.price, { price: 0.1499, period: "2026-08", estimate: true });

  const july = loadEnergyMonth(db, "2026-07", noon("2026-11-16"));
  assert.equal(july.days[0]?.price?.price, 0.1512, "July is priced at July's price");

  const fallback = loadEnergyMonth(db, "nonsense", noon("2026-12-02"));
  assert.equal(fallback.month, "2026-12");
  assert.deepEqual(fallback.days, []);
  assert.deepEqual(fallback.total, { kwh: null, cost: null });
  assert.deepEqual(fallback.months.slice(0, 2), ["2026-12", "2026-11"], "the current month even before its first reading");

  writeSetting(db, "energy_price_location", "EU-DE");
  const euro = loadEnergyMonth(db, "2026-08", noon("2026-11-16"));
  assert.equal(euro.location?.currency, "EUR");
  assert.deepEqual(euro.days[1]?.price, { price: 0.3618, period: "2026-S1", estimate: true });

  writeSetting(db, "energy_price_location", "XX-ZZ");
  assert.equal(loadEnergyMonth(db, "2026-08", noon("2026-11-16")).location, null, "a stored place no longer known is none");
});

test("a place's periods, oldest first, and none for no place", () => {
  const db = seedMonth();
  assert.deepEqual(loadPricePeriods(db, energyLocation("US-FL")).map((period) => period.period), ["2026-07", "2026-08"]);
  assert.deepEqual(loadPricePeriods(db, energyLocation("EU-FR")), []);
  assert.deepEqual(loadPricePeriods(db, null), []);
});

test("picking a place is saved and audited by name; picking it again changes nothing", () => {
  const db = tempDb();
  const admin = db
    .insert(users)
    .values({ username: "admin", firstName: "A", lastName: "B", passwordHash: "x", role: "admin", createdAt: 0, updatedAt: 0 })
    .returning()
    .get();
  assert.equal(saveEnergyLocation(db, energyLocation("US-FL")!, admin.id, 1000), true);
  assert.equal(saveEnergyLocation(db, energyLocation("US-FL")!, admin.id, 2000), false);
  assert.equal(saveEnergyLocation(db, energyLocation("EU-DE")!, admin.id, 3000), true);
  assert.equal(readSetting(db, "energy_price_location"), "EU-DE");
  assert.equal(loadEnergyLocation(db)?.name, "Germany");
  const audit = db.select().from(auditLog).all().filter((entry) => entry.action === "energy_price_location_set");
  assert.deepEqual(
    audit.map((entry) => [entry.actorUserId, JSON.parse(entry.details ?? "null")]),
    [
      [admin.id, { location: { from: null, to: "Florida, US" } }],
      [admin.id, { location: { from: "Florida, US", to: "Germany" } }],
    ],
  );
});

test("Settings' price line: the price in its unit, its period and its source, or why there is none", () => {
  const florida = energyLocation("US-FL");
  const germany = energyLocation("EU-DE");
  assert.equal(priceSummary(null, null), null);
  assert.equal(priceSummary(florida, { price: 0.1499, period: "2026-08", estimate: true }), "14.99 ¢/kWh · August 2026 · EIA");
  assert.equal(priceSummary(germany, { price: 0.3618, period: "2026-S1", estimate: false }), "0.3618 €/kWh · Jan to Jun 2026 · Eurostat");
  assert.equal(priceSummary(florida, null), "No prices downloaded yet.");
  assert.equal(priceSummary(florida, null, "HTTP 503"), "No prices downloaded yet: HTTP 503");
});
