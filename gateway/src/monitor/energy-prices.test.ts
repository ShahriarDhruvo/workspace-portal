import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc } from "drizzle-orm";
import { energyPrices, openDatabase } from "@portal/core";
import { EIA_URL, EnergyPrices, EUROSTAT_URL, parseEiaTable, parseEurostat, PriceFormatError, type PriceRow } from "./energy-prices.ts";
import type { Logger, LogFields } from "../lib/log.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "..", "test", "fixtures");
// Fetched on 2026-11-16: EIA's Table 5.6.A for August 2026 and 2025, Eurostat's last six half years.
const EIA = fs.readFileSync(path.join(FIXTURES, "eia-table-5-6-a.html"), "utf8");
const EUROSTAT = fs.readFileSync(path.join(FIXTURES, "eurostat-nrg-pc-204.json"), "utf8");

const of = (rows: readonly PriceRow[], location: string) => rows.filter((row) => row.location === location);

test("EIA: every state's residential price for the latest month and a year before, in dollars per kWh", () => {
  const rows = parseEiaTable(EIA);
  assert.deepEqual(of(rows, "US-FL"), [
    { location: "US-FL", periodStart: "2026-08-01", periodEnd: "2026-09-01", period: "2026-08", price: 0.1499, currency: "USD", source: "eia" },
    { location: "US-FL", periodStart: "2025-08-01", periodEnd: "2025-09-01", period: "2025-08", price: 0.1533, currency: "USD", source: "eia" },
  ]);
  assert.equal(new Set(rows.map((row) => row.location)).size, 51, "the 50 states and DC");
  assert.equal(of(rows, "US-DC")[0]?.price, 0.2598);
  assert.equal(of(rows, "US-HI").length, 2);
  // Census divisions and the U.S. total are rows of the table, not places.
  assert.ok(rows.every((row) => /^US-[A-Z]{2}$/.test(row.location)));
  assert.ok(rows.every((row) => row.price > 0.05 && row.price < 0.6), "cents became dollars");
});

test("EIA: a December rolls over into January, and withheld values are skipped", () => {
  const html = EIA.replaceAll("August 2026", "December 2026").replaceAll("August 2025", "December 2025").replace(
    /(>Florida<\/td>\s*<td[^>]*>)\s*14\.99/,
    "$1--",
  );
  const florida = of(parseEiaTable(html), "US-FL");
  assert.deepEqual(
    florida.map((row) => [row.period, row.periodStart, row.periodEnd]),
    [["2025-12", "2025-12-01", "2026-01-01"]],
  );
});

test("EIA: a page whose layout changed is a format error, not a wrong price", () => {
  assert.throws(() => parseEiaTable("<html>Service unavailable</html>"), PriceFormatError);
  assert.throws(() => parseEiaTable(EIA.replace(/>Residential</, ">Households<")), /Residential/);
  assert.throws(() => parseEiaTable(EIA.replaceAll("August 2026", "Aug-26")), /months/);
  const fewStates = EIA.replace(/<tr>\s*<td[^>]*>(Florida|Georgia|Texas|Ohio|Iowa|Utah|Maine)<\/td>[\s\S]*?<\/tr>/g, "");
  assert.throws(() => parseEiaTable(fewStates), /only 44 states/);
});

test("Eurostat: each country's household price per half year in euros, without the EU totals", () => {
  const rows = parseEurostat(EUROSTAT);
  assert.deepEqual(of(rows, "EU-DE").at(-1), {
    location: "EU-DE",
    periodStart: "2026-01-01",
    periodEnd: "2026-07-01",
    period: "2026-S1",
    price: 0.3618,
    currency: "EUR",
    source: "eurostat",
  });
  assert.deepEqual(
    of(rows, "EU-DE").map((row) => [row.period, row.periodStart, row.periodEnd]),
    [
      ["2023-S2", "2023-07-01", "2024-01-01"],
      ["2024-S1", "2024-01-01", "2024-07-01"],
      ["2024-S2", "2024-07-01", "2025-01-01"],
      ["2025-S1", "2025-01-01", "2025-07-01"],
      ["2025-S2", "2025-07-01", "2026-01-01"],
      ["2026-S1", "2026-01-01", "2026-07-01"],
    ],
  );
  assert.equal(of(rows, "EU-EL").at(-1)?.price, 0.2401, "Greece is EL");
  assert.equal(of(rows, "EU-XK").at(-1)?.price, 0.0869);
  assert.ok(rows.every((row) => row.location !== "EU-EU27_2020" && row.location !== "EU-UK"));
  assert.equal(new Set(rows.map((row) => row.location)).size, 39);
});

test("Eurostat: the answer must be for the query's band, unit, taxes and currency, one value per country and half year", () => {
  const data = JSON.parse(EUROSTAT) as Record<string, unknown> & { dimension: Record<string, { category: { index: Record<string, number> } }>; size: number[] };
  assert.throws(() => parseEurostat("<html>"), /JSON/);
  assert.throws(() => parseEurostat(JSON.stringify({ ...data, value: null })), /JSON-stat/);
  const national = structuredClone(data);
  national.dimension.currency!.category.index = { NAC: 0 };
  assert.throws(() => parseEurostat(JSON.stringify(national)), /currency EUR/);
  const twoTaxes = structuredClone(data);
  twoTaxes.size[data.size.length - 4] = 2;
  assert.throws(() => parseEurostat(JSON.stringify(twoTaxes)), /more than one value/);
  const few = structuredClone(data);
  few.value = { "100": 0.3 };
  assert.throws(() => parseEurostat(JSON.stringify(few)), /only 1 countries/);
  // JSON-stat may also give the values as a list.
  const list = structuredClone(data);
  const values = data.value as Record<string, number>;
  list.value = Array.from({ length: data.size.reduce((a, b) => a * b, 1) }, (_, at) => values[String(at)] ?? null);
  assert.deepEqual(parseEurostat(JSON.stringify(list)), parseEurostat(EUROSTAT));
});

function recorder(): Logger & { lines: Array<[string, string, LogFields | undefined]> } {
  const lines: Array<[string, string, LogFields | undefined]> = [];
  return {
    lines,
    info: (message, fields) => lines.push(["info", message, fields]),
    warn: (message, fields) => lines.push(["warn", message, fields]),
    error: (message, fields) => lines.push(["error", message, fields]),
  };
}

function tempDb() {
  return openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portal-prices-")), "test.sqlite"));
}

test("EnergyPrices: stores both sources, keeps what it has when one fails, replaces revised figures", async () => {
  const db = tempDb();
  const log = recorder();
  const clock = { now: 1_000 };
  let answers: Record<string, string | Error> = { [EIA_URL]: EIA, [EUROSTAT_URL]: EUROSTAT };
  const asked: string[] = [];
  const prices = new EnergyPrices({
    db,
    log,
    now: () => clock.now,
    fetchText: async (url) => {
      asked.push(url);
      const answer = answers[url];
      if (answer instanceof Error || answer === undefined) throw answer ?? new Error("unknown URL");
      return answer;
    },
  });

  const first = await prices.refresh();
  assert.deepEqual(first, {
    eia: { at: 1_000, okAt: 1_000, rows: 102, error: null },
    eurostat: { at: 1_000, okAt: 1_000, rows: first.eurostat.rows, error: null },
  });
  const florida = () => db.select().from(energyPrices).orderBy(asc(energyPrices.periodStart)).all().filter((row) => row.location === "US-FL");
  assert.deepEqual(
    florida().map((row) => [row.period, row.price, row.fetchedAt]),
    [
      ["2025-08", 0.1533, 1_000],
      ["2026-08", 0.1499, 1_000],
    ],
  );

  // On demand within 10 minutes: nothing is asked again.
  asked.length = 0;
  clock.now += 60_000;
  await prices.refresh();
  assert.deepEqual(asked, []);

  // EIA revises August and Eurostat is down: the revision is stored, Eurostat's rows stay.
  clock.now += 24 * 60 * 60_000;
  const before = db.select().from(energyPrices).all().filter((row) => row.source === "eurostat").length;
  answers = { [EIA_URL]: EIA.replace(/(>Florida<\/td>\s*<td[^>]*>)\s*14\.99/, "$1 15.02"), [EUROSTAT_URL]: new Error("HTTP 503") };
  const second = await prices.refresh({ force: true });
  assert.deepEqual(second.eurostat, { at: clock.now, okAt: 1_000, rows: first.eurostat.rows, error: "HTTP 503" });
  assert.equal(second.eia.error, null);
  assert.deepEqual(
    florida().map((row) => [row.period, row.price, row.fetchedAt]),
    [
      ["2025-08", 0.1533, clock.now],
      ["2026-08", 0.1502, clock.now],
    ],
  );
  assert.equal(db.select().from(energyPrices).all().filter((row) => row.source === "eurostat").length, before);
  assert.ok(log.lines.some(([level, message, fields]) => level === "warn" && /download failed/.test(message) && fields?.source === "eurostat"));

  // A changed layout is logged as an error and changes nothing.
  answers = { [EIA_URL]: "<html>new design</html>", [EUROSTAT_URL]: EUROSTAT };
  const third = await prices.refresh({ force: true });
  assert.match(third.eia.error ?? "", /Table 5\.6\.A/);
  assert.equal(florida()[1]?.price, 0.1502);
  assert.ok(log.lines.some(([level, , fields]) => level === "error" && fields?.source === "eia"));
});

test("EnergyPrices: concurrent refreshes share one download", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const prices = new EnergyPrices({
    db: tempDb(),
    log: recorder(),
    fetchText: async (url) => {
      calls++;
      await gate;
      return url === EIA_URL ? EIA : EUROSTAT;
    },
  });
  const a = prices.refresh();
  const b = prices.refresh({ force: true });
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 2, "one per source");
});
