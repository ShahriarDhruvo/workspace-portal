// Energy and its cost for Admin > Usage: both servers' daily totals (host_daily, kept current by the gateway's
// energy meter) priced at the electricity price in force each day (energy_rates). Server side only, but it takes
// the database as an argument (no server-only imports) so it can be unit tested; the page and
// GET /api/admin/energy pass getDb(), the price action lib/actions/energy.ts.
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { energyRates, hostDaily, usageDay, writeAudit, type PortalDb } from "@portal/db";

/** A price, in force from its day until the next one's. */
export interface EnergyPrice {
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  centsPerKwh: number;
  note: string | null;
}

/** One day of both servers. null: not measurable (a server without a power sensor) or not priced (no price yet). */
export interface EnergyDay {
  /** YYYY-MM-DD. */
  day: string;
  llmKwh: number | null;
  portalKwh: number | null;
  /** The servers that could be measured, together. */
  kwh: number | null;
  centsPerKwh: number | null;
  usd: number | null;
}

export interface EnergyTotal {
  kwh: number | null;
  usd: number | null;
}

export interface EnergyMonth {
  /** YYYY-MM: the month shown. */
  month: string;
  /** YYYY-MM-DD: the server's local day, which `today` is about. */
  today: string;
  /** The month's days that have readings, newest first. */
  days: EnergyDay[];
  total: EnergyTotal;
  /** Today so far, whichever month is shown. */
  todayTotal: EnergyTotal;
  /** The months with readings, newest first; always includes the current one. */
  months: string[];
  /** Every price, newest first. */
  prices: EnergyPrice[];
  /** The price in force today. */
  price: EnergyPrice | null;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A YYYY-MM month (from a URL). */
export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

/** YYYY-MM-DD that names a real calendar day. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The price in force on `day`: the latest that starts on or before it. `prices` oldest first. */
export function priceOn(prices: readonly EnergyPrice[], day: string): EnergyPrice | null {
  let found: EnergyPrice | null = null;
  for (const price of prices) {
    if (price.effectiveFrom > day) break;
    found = price;
  }
  return found;
}

/** Adds up what is known: null only when every part is. */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/** A day's servers (host_daily rows, Wh) priced at the price in force that day. */
export function priceDay(day: string, rows: ReadonlyArray<{ role: string; energyWh: number | null }>, price: EnergyPrice | null): EnergyDay {
  const kwhOf = (role: string): number | null => {
    const wh = rows.find((row) => row.role === role)?.energyWh;
    return wh === null || wh === undefined ? null : wh / 1000;
  };
  const llmKwh = kwhOf("llm");
  const portalKwh = kwhOf("portal");
  const kwh = sumKnown([llmKwh, portalKwh]);
  const centsPerKwh = price?.centsPerKwh ?? null;
  return { day, llmKwh, portalKwh, kwh, centsPerKwh, usd: kwh === null || centsPerKwh === null ? null : (kwh * centsPerKwh) / 100 };
}

/** The days together; each day costs what its own price says. */
export function totalOf(days: readonly EnergyDay[]): EnergyTotal {
  return { kwh: sumKnown(days.map((day) => day.kwh)), usd: sumKnown(days.map((day) => day.usd)) };
}

type DayRow = { day: string; role: string; energyWh: number | null };

/** host_daily rows grouped by day and priced, newest first. */
function pricedDays(rows: readonly DayRow[], prices: readonly EnergyPrice[]): EnergyDay[] {
  const byDay = new Map<string, DayRow[]>();
  for (const row of rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  return [...byDay.keys()]
    .sort()
    .reverse()
    .map((day) => priceDay(day, byDay.get(day) ?? [], priceOn(prices, day)));
}

/** Every price, oldest first. */
function loadPrices(db: PortalDb): EnergyPrice[] {
  return db
    .select({ effectiveFrom: energyRates.effectiveFrom, centsPerKwh: energyRates.centsPerKwh, note: energyRates.note })
    .from(energyRates)
    .orderBy(asc(energyRates.effectiveFrom))
    .all();
}

/**
 * A month of both servers' energy and its cost (the current month when `month` isn't one), today so far, the
 * months there are, and the prices. `now` decides what today is (the server's local day, as the meter's).
 */
export function loadEnergyMonth(db: PortalDb, month?: string | null, now: Date = new Date()): EnergyMonth {
  const today = usageDay(now);
  const current = today.slice(0, 7);
  const shown = isMonth(month) ? month : current;
  const prices = loadPrices(db);
  const columns = { day: hostDaily.day, role: hostDaily.role, energyWh: hostDaily.energyWh };
  const monthRows = db
    .select(columns)
    .from(hostDaily)
    .where(and(gte(hostDaily.day, `${shown}-01`), lte(hostDaily.day, `${shown}-31`)))
    .all();
  const days = pricedDays(monthRows, prices);
  const todayRows = shown === current ? monthRows.filter((row) => row.day === today) : db.select(columns).from(hostDaily).where(eq(hostDaily.day, today)).all();
  const monthColumn = sql<string>`substr(${hostDaily.day}, 1, 7)`;
  const withData = db.selectDistinct({ month: monthColumn }).from(hostDaily).orderBy(desc(monthColumn)).all();
  const months = [...new Set([current, ...withData.map((row) => row.month)])].filter(isMonth).sort().reverse();
  return {
    month: shown,
    today,
    days,
    total: totalOf(days),
    todayTotal: totalOf(pricedDays(todayRows, prices)),
    months,
    prices: [...prices].reverse(),
    price: priceOn(prices, today),
  };
}

/** The price form (lib/actions/energy.ts): a day, cents per kWh (to a thousandth), an optional note. */
export const energyPriceSchema = z.object({
  effectiveFrom: z.string().trim().refine(isDay, "Pick a day."),
  centsPerKwh: z
    .string()
    .trim()
    .min(1, "Enter the price.")
    .transform(Number)
    .pipe(z.number({ message: "Enter a number." }).min(0, "It can't be negative.").max(1000, "At most 1,000 ¢."))
    .transform((cents) => Math.round(cents * 1000) / 1000),
  note: z
    .string()
    .trim()
    .max(120, "At most 120 characters.")
    .transform((note) => note || null),
});

export type EnergyPriceInput = z.output<typeof energyPriceSchema>;

const priceText = (cents: number) => `${cents} ¢/kWh`;

/**
 * Sets the price in force from a day on (replacing the one that starts that same day, if any) and audits it as
 * `energy_rate_set`, with the price it replaced.
 */
export function saveEnergyPrice(db: PortalDb, input: EnergyPriceInput, actorUserId: number, now = Date.now()): void {
  db.transaction(() => {
    const before = db.select().from(energyRates).where(eq(energyRates.effectiveFrom, input.effectiveFrom)).get();
    db.insert(energyRates)
      .values({ ...input, createdAt: now })
      .onConflictDoUpdate({ target: energyRates.effectiveFrom, set: { centsPerKwh: input.centsPerKwh, note: input.note, createdAt: now } })
      .run();
    writeAudit(db, {
      action: "energy_rate_set",
      actorUserId,
      details: {
        effectiveFrom: input.effectiveFrom,
        price: before ? { from: priceText(before.centsPerKwh), to: priceText(input.centsPerKwh) } : priceText(input.centsPerKwh),
        ...(input.note ? { note: input.note } : {}),
      },
    });
  });
}
