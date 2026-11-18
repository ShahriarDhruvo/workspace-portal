// Energy and its cost for Admin > Energy. It takes the database as an argument (no server-only imports), so it can
// be unit tested.
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  ENERGY_SOURCE_NAMES,
  energyLocation,
  energyLocationLabel,
  energyPrices,
  hostDaily,
  readSetting,
  usageDay,
  writeAudit,
  writeSetting,
  type EnergyLocation,
  type PortalDb,
} from "@portal/core";
import { formatPricePeriod, formatUnitPrice, priceUnit } from "./live-format.ts";

/** A published price, for the days from `periodStart` up to (not including) `periodEnd`. */
export interface PricePeriod {
  periodStart: string;
  periodEnd: string;
  /** "2026-08" (a month) or "2026-S1" (a half year). */
  period: string;
  /** In the place's currency per kWh. */
  price: number;
}

/** The price a day is charged at. */
export interface DayPrice {
  /** In the place's currency per kWh. */
  price: number;
  period: string;
  /** The day is outside the period: its month isn't published yet, so the latest figure stands in. */
  estimate: boolean;
}

/** One day of both servers. null: not measurable (a server without a power sensor) or not priced (no place or price). */
export interface EnergyDay {
  /** YYYY-MM-DD. */
  day: string;
  llmKwh: number | null;
  portalKwh: number | null;
  /** The servers that could be measured, together. */
  kwh: number | null;
  price: DayPrice | null;
  /** In the place's currency. */
  cost: number | null;
}

export interface EnergyTotal {
  kwh: number | null;
  cost: number | null;
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
  /** Where prices come from; null until the admin picks a place in Settings. */
  location: EnergyLocation | null;
  /** Today's price there; null without a place or before its prices are downloaded. */
  price: DayPrice | null;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A YYYY-MM month (from a URL). */
export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

/**
 * The price of `day`: the newest period that starts on or before it, or the oldest when it is older than every
 * period. Outside its period the figure is an estimate (the month is not published yet). `periods` oldest first.
 */
export function priceOn(periods: readonly PricePeriod[], day: string): DayPrice | null {
  let found = periods[0];
  for (const period of periods) {
    if (period.periodStart > day) break;
    found = period;
  }
  if (!found) return null;
  return { price: found.price, period: found.period, estimate: day < found.periodStart || day >= found.periodEnd };
}

/** Adds up what is known: null only when every part is. */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/** A day's servers (host_daily rows, Wh) priced at that day's price. */
export function priceDay(day: string, rows: ReadonlyArray<{ role: string; energyWh: number | null }>, price: DayPrice | null): EnergyDay {
  const kwhOf = (role: string): number | null => {
    const wh = rows.find((row) => row.role === role)?.energyWh;
    return wh === null || wh === undefined ? null : wh / 1000;
  };
  const llmKwh = kwhOf("llm");
  const portalKwh = kwhOf("portal");
  const kwh = sumKnown([llmKwh, portalKwh]);
  return { day, llmKwh, portalKwh, kwh, price, cost: kwh === null || price === null ? null : kwh * price.price };
}

/** The days together; each day costs what its own price says. */
export function totalOf(days: readonly EnergyDay[]): EnergyTotal {
  return { kwh: sumKnown(days.map((day) => day.kwh)), cost: sumKnown(days.map((day) => day.cost)) };
}

type DayRow = { day: string; role: string; energyWh: number | null };

/** host_daily rows grouped by day and priced, newest first. */
function pricedDays(rows: readonly DayRow[], periods: readonly PricePeriod[]): EnergyDay[] {
  const byDay = new Map<string, DayRow[]>();
  for (const row of rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  return [...byDay.keys()]
    .sort()
    .reverse()
    .map((day) => priceDay(day, byDay.get(day) ?? [], priceOn(periods, day)));
}

/** The place the admin picked (a stored id no longer known counts as none). */
export function loadEnergyLocation(db: PortalDb): EnergyLocation | null {
  return energyLocation(readSetting(db, "energy_price_location"));
}

/** A place's published prices, oldest first. */
export function loadPricePeriods(db: PortalDb, location: EnergyLocation | null): PricePeriod[] {
  if (!location) return [];
  return db
    .select({ periodStart: energyPrices.periodStart, periodEnd: energyPrices.periodEnd, period: energyPrices.period, price: energyPrices.price })
    .from(energyPrices)
    .where(eq(energyPrices.location, location.id))
    .orderBy(asc(energyPrices.periodStart))
    .all();
}

/**
 * A month of both servers' energy and its cost (the current month when `month` isn't one), today so far, the
 * months there are, and the place and today's price. `now` decides what today is (the server's local day, as the
 * meter's).
 */
export function loadEnergyMonth(db: PortalDb, month?: string | null, now: Date = new Date()): EnergyMonth {
  const today = usageDay(now);
  const current = today.slice(0, 7);
  const shown = isMonth(month) ? month : current;
  const location = loadEnergyLocation(db);
  const periods = loadPricePeriods(db, location);
  const columns = { day: hostDaily.day, role: hostDaily.role, energyWh: hostDaily.energyWh };
  const monthRows = db
    .select(columns)
    .from(hostDaily)
    .where(and(gte(hostDaily.day, `${shown}-01`), lte(hostDaily.day, `${shown}-31`)))
    .all();
  const days = pricedDays(monthRows, periods);
  const todayRows = shown === current ? monthRows.filter((row) => row.day === today) : db.select(columns).from(hostDaily).where(eq(hostDaily.day, today)).all();
  const monthColumn = sql<string>`substr(${hostDaily.day}, 1, 7)`;
  const withData = db.selectDistinct({ month: monthColumn }).from(hostDaily).orderBy(desc(monthColumn)).all();
  const months = [...new Set([current, ...withData.map((row) => row.month)])].filter(isMonth).sort().reverse();
  return {
    month: shown,
    today,
    days,
    total: totalOf(days),
    todayTotal: totalOf(pricedDays(todayRows, periods)),
    months,
    location,
    price: priceOn(periods, today),
  };
}

/**
 * Makes `location` the place Admin > Energy prices energy for, audited as `energy_price_location_set` (with the
 * places by name, "Florida, US"). Nothing changes, and nothing is audited, when it already is. Returns whether it
 * changed.
 */
export function saveEnergyLocation(db: PortalDb, location: EnergyLocation, actorUserId: number, now = Date.now()): boolean {
  return db.transaction(() => {
    const before = loadEnergyLocation(db);
    if (before?.id === location.id) return false;
    writeSetting(db, "energy_price_location", location.id, now);
    writeAudit(db, {
      action: "energy_price_location_set",
      actorUserId,
      details: { location: { from: before ? energyLocationLabel(before) : null, to: energyLocationLabel(location) } },
    });
    return true;
  });
}

/**
 * Settings' line under the place: its price today, "14.99 ¢/kWh · August 2026 · EIA", or that none is downloaded
 * yet (with the last download's error, when it failed). null without a place.
 */
export function priceSummary(location: EnergyLocation | null, price: DayPrice | null, downloadError: string | null = null): string | null {
  if (!location) return null;
  if (!price) return downloadError ? `No prices downloaded yet: ${downloadError}` : "No prices downloaded yet.";
  return `${formatUnitPrice(price.price, location.currency)} ${priceUnit(location.currency)} · ${formatPricePeriod(price.period)} · ${ENERGY_SOURCE_NAMES[location.source]}`;
}
