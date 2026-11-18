// Published electricity prices for Admin > Energy (packages/core energy-locations.ts): every place's, from both
// sources, into energy_prices, at the gateway's start, every 24 h and when the admin picks a place
// (POST /control/energy-prices/refresh). Both sources publish without an account or key. A source that fails
// leaves what is stored as it was; a page whose layout changed is an error in the log, never a wrong price.
//   * EIA, Electric Power Monthly Table 5.6.A (HTML): every state's average residential price, in cents per kWh,
//     for the latest month published and the same month a year before. EIA revises recent months, so a later
//     download replaces a month's figure; months accumulate as they are published.
//   * Eurostat nrg_pc_204 (JSON-stat): household prices with all taxes, band 2,500-4,999 kWh a year, in euros per
//     kWh, for the last six half years.
import { sql } from "drizzle-orm";
import { ENERGY_LOCATIONS, ENERGY_PRICE_SOURCES, energyPrices, type EnergyCurrency, type EnergyPriceSource, type EnergyPriceStatus, type PortalDb } from "@portal/core";
import { fetchBounded } from "../lib/bounded-body.ts";
import type { Logger } from "../lib/log.ts";
import { singleFlight } from "../lib/single-flight.ts";

export const EIA_URL = "https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a";
export const EUROSTAT_URL =
  "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_pc_204?nrg_cons=KWH2500-4999&unit=KWH&tax=I_TAX&currency=EUR&lastTimePeriod=6";

const SOURCE_URLS: Readonly<Record<EnergyPriceSource, string>> = { eia: EIA_URL, eurostat: EUROSTAT_URL };
const TIMEOUT_MS = 20_000;
/** The EIA page is about 105 KB and Eurostat's answer 8 KB. */
const MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 24 * 60 * 60_000;
/** A source downloaded this recently is not asked again on demand (the admin trying places one after another). */
const FRESH_MS = 10 * 60_000;
/** Fewer than this many places found means the page is not the table it used to be. */
const MIN_STATES = 45;
const MIN_COUNTRIES = 20;

/** One energy_prices row, without its download time. */
export interface PriceRow {
  location: string;
  periodStart: string;
  periodEnd: string;
  period: string;
  price: number;
  currency: EnergyCurrency;
  source: EnergyPriceSource;
}

/** The source answered with something the parser does not recognize: its layout changed. */
export class PriceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceFormatError";
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number): string => String(n).padStart(2, "0");

function monthPeriod(year: number, month: number): Pick<PriceRow, "periodStart" | "periodEnd" | "period"> {
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  return { periodStart: `${year}-${pad(month)}-01`, periodEnd: `${next[0]}-${pad(next[1]!)}-01`, period: `${year}-${pad(month)}` };
}

function halfYearPeriod(year: number, half: 1 | 2): Pick<PriceRow, "periodStart" | "periodEnd" | "period"> {
  return half === 1
    ? { periodStart: `${year}-01-01`, periodEnd: `${year}-07-01`, period: `${year}-S1` }
    : { periodStart: `${year}-07-01`, periodEnd: `${year + 1}-01-01`, period: `${year}-S2` };
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A table cell's text: tags out, entities decoded, white space collapsed. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] === "#") return String.fromCodePoint(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1]!.matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((cell) => cellText(cell[2]!)));
}

/** "August 2026" → [2026, 8]. */
function monthHeader(text: string | undefined): [number, number] | null {
  const match = /^([A-Z][a-z]+) (\d{4})$/.exec(text ?? "");
  const month = match ? MONTHS.indexOf(match[1]!) + 1 : 0;
  return match && month > 0 ? [Number(match[2]), month] : null;
}

const STATES = new Map(ENERGY_LOCATIONS.filter((location) => location.source === "eia").map((location) => [location.name, location]));

/**
 * EIA's Table 5.6.A: the Residential pair of columns (the first after the place), each headed by its month. Rows
 * of census divisions and the U.S. total are not places; a value EIA withholds ("--", "NM", "W") is skipped.
 */
export function parseEiaTable(html: string): PriceRow[] {
  if (!/Table 5\.6\.A\./.test(html)) throw new PriceFormatError("EIA's page no longer names Table 5.6.A");
  const rows = tableRows(html);
  const groups = rows.findIndex((cells) => cells.includes("Residential"));
  if (groups < 0 || rows[groups]![1] !== "Residential") throw new PriceFormatError("EIA's table has no Residential columns first");
  const months = rows[groups + 1] ?? [];
  const periods = [monthHeader(months[1]), monthHeader(months[2])];
  if (!/Census Division/i.test(months[0] ?? "") || periods.some((period) => period === null)) {
    throw new PriceFormatError(`EIA's table no longer heads its Residential columns with months (${JSON.stringify(months.slice(0, 3))})`);
  }
  const found: PriceRow[] = [];
  const states = new Set<string>();
  for (const cells of rows.slice(groups + 2)) {
    const location = STATES.get(cells[0] ?? "");
    if (!location) continue;
    states.add(location.id);
    periods.forEach((period, column) => {
      const text = cells[column + 1] ?? "";
      const cents = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
      if (!(cents > 0 && cents < 500)) return;
      found.push({ location: location.id, ...monthPeriod(...period!), price: Math.round(cents * 1000) / 100_000, currency: "USD", source: "eia" });
    });
  }
  if (states.size < MIN_STATES) throw new PriceFormatError(`EIA's table lists only ${states.size} states`);
  return found;
}

interface JsonStatCategory {
  index?: Record<string, number> | string[];
}

const COUNTRIES = new Map(ENERGY_LOCATIONS.filter((location) => location.source === "eurostat").map((location) => [location.code, location]));

/** A JSON-stat dimension's codes by position (the index is an object of positions, or a list). */
function positions(category: JsonStatCategory | undefined): Map<string, number> {
  const index = category?.index;
  if (Array.isArray(index)) return new Map(index.map((code, position) => [code, position]));
  return new Map(Object.entries(index ?? {}));
}

/**
 * Eurostat's JSON-stat answer: one value per country and half year, every other dimension fixed by the query
 * (household band DC, kWh, all taxes, EUR), which is checked. Its EU and euro-area totals are not places.
 */
export function parseEurostat(text: string): PriceRow[] {
  let data: { id?: unknown; size?: unknown; dimension?: Record<string, { category?: JsonStatCategory }>; value?: unknown };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new PriceFormatError("Eurostat did not answer with JSON");
  }
  const { id, size, dimension, value } = data;
  if (!Array.isArray(id) || !Array.isArray(size) || id.length !== size.length || !dimension || value === null || typeof value !== "object") {
    throw new PriceFormatError("Eurostat's answer is not JSON-stat");
  }
  for (const [name, code] of [["unit", "KWH"], ["tax", "I_TAX"], ["currency", "EUR"], ["nrg_cons", "KWH2500-4999"]] as const) {
    if (!positions(dimension[name]?.category).has(code)) throw new PriceFormatError(`Eurostat's answer is not for ${name} ${code}`);
  }
  const geoAt = id.indexOf("geo");
  const timeAt = id.indexOf("time");
  if (geoAt < 0 || timeAt < 0) throw new PriceFormatError("Eurostat's answer has no geo or time dimension");
  if (size.some((n, at) => at !== geoAt && at !== timeAt && n !== 1)) throw new PriceFormatError("Eurostat's answer has more than one value per country and half year");
  // Row-major: the last dimension varies fastest.
  const stride = (at: number): number => (size as number[]).slice(at + 1).reduce((product, n) => product * n, 1);
  const values = value as Record<string, unknown> | unknown[];
  const found: PriceRow[] = [];
  const countries = new Set<string>();
  const times = [...positions(dimension.time?.category)];
  for (const [code, geo] of positions(dimension.geo?.category)) {
    const location = COUNTRIES.get(code);
    if (!location) continue;
    for (const [label, time] of times) {
      const half = /^(\d{4})-S([12])$/.exec(label);
      if (!half) throw new PriceFormatError(`Eurostat's period ${label} is not a half year`);
      const at = geo * stride(geoAt) + time * stride(timeAt);
      const price = Array.isArray(values) ? values[at] : values[String(at)];
      if (typeof price !== "number" || !(price > 0 && price < 5)) continue;
      countries.add(location.id);
      found.push({ location: location.id, ...halfYearPeriod(Number(half[1]), half[2] === "1" ? 1 : 2), price, currency: "EUR", source: "eurostat" });
    }
  }
  if (countries.size < MIN_COUNTRIES) throw new PriceFormatError(`Eurostat's answer has prices for only ${countries.size} countries`);
  return found;
}

const PARSERS: Readonly<Record<EnergyPriceSource, (body: string) => PriceRow[]>> = { eia: parseEiaTable, eurostat: parseEurostat };

/** Downloads a source's document as text (the body read up to MAX_BYTES). */
export type FetchText = (url: string) => Promise<string>;

export async function fetchText(url: string): Promise<string> {
  const headers = { accept: "text/html, application/json", "user-agent": "workspace-portal (energy prices)" };
  const { ok, status, text } = await fetchBounded(fetch, url, { headers, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
  if (!ok) throw new Error(`HTTP ${status}`);
  if (text === null) throw new Error(`the answer is larger than ${MAX_BYTES / 1024 / 1024} MiB`);
  return text;
}

export interface EnergyPricesOptions {
  db: PortalDb;
  log: Logger;
  fetchText?: FetchText;
  now?: () => number;
  refreshMs?: number;
}

export class EnergyPrices {
  readonly #db: PortalDb;
  readonly #log: Logger;
  readonly #fetch: FetchText;
  readonly #now: () => number;
  readonly #refreshMs: number;
  readonly #status: EnergyPriceStatus = {
    eia: { at: null, okAt: null, rows: 0, error: null },
    eurostat: { at: null, okAt: null, rows: 0, error: null },
  };
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EnergyPricesOptions) {
    this.#db = options.db;
    this.#log = options.log;
    this.#fetch = options.fetchText ?? fetchText;
    this.#now = options.now ?? Date.now;
    this.#refreshMs = options.refreshMs ?? REFRESH_MS;
  }

  /** Downloads now (not awaited) and then every 24 h until stop(). */
  start(): void {
    if (this.#timer !== null) return;
    void this.refresh({ force: true });
    this.#timer = setInterval(() => void this.refresh({ force: true }), this.#refreshMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  status(): EnergyPriceStatus {
    return structuredClone(this.#status);
  }

  /**
   * Downloads both sources and stores what they publish. A refresh already running is joined; on demand (without
   * `force`), a source downloaded within FRESH_MS is not asked again.
   */
  readonly refresh = singleFlight(({ force = false }: { force?: boolean } = {}) => this.#refreshAll(force));

  async #refreshAll(force: boolean): Promise<EnergyPriceStatus> {
    const due = ENERGY_PRICE_SOURCES.filter((source) => {
      const okAt = this.#status[source].okAt;
      return force || okAt === null || this.#now() - okAt >= FRESH_MS;
    });
    await Promise.all(due.map((source) => this.#refreshSource(source)));
    return this.status();
  }

  async #refreshSource(source: EnergyPriceSource): Promise<void> {
    const status = this.#status[source];
    status.at = this.#now();
    try {
      const rows = PARSERS[source](await this.#fetch(SOURCE_URLS[source]));
      this.#store(rows, status.at);
      Object.assign(status, { okAt: status.at, rows: rows.length, error: null });
      const periods = [...new Set(rows.map((row) => row.period))].sort();
      this.#log.info("energy prices downloaded", { source, rows: rows.length, periods: periods.join(",") });
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
      // A changed layout needs a new parser; a network failure only a later try.
      const fields = { source, url: SOURCE_URLS[source], error: status.error, kept: "the prices stored before" };
      if (error instanceof PriceFormatError) this.#log.error("energy prices: the source's format changed", fields);
      else this.#log.warn("energy prices: download failed", fields);
    }
  }

  /** Every row, replacing a period's earlier figure (sources revise recent ones). One transaction. */
  #store(rows: readonly PriceRow[], fetchedAt: number): void {
    if (rows.length === 0) return;
    this.#db.transaction((tx) => {
      for (let start = 0; start < rows.length; start += 500) {
        tx.insert(energyPrices)
          .values(rows.slice(start, start + 500).map((row) => ({ ...row, fetchedAt })))
          .onConflictDoUpdate({
            target: [energyPrices.location, energyPrices.periodStart],
            set: {
              periodEnd: sql`excluded.period_end`,
              period: sql`excluded.period`,
              price: sql`excluded.price`,
              currency: sql`excluded.currency`,
              source: sql`excluded.source`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          })
          .run();
      }
    });
  }
}
