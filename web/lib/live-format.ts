// Formatting and history for Admin > Usage's live view, Admin > Energy and the API page.
import { formatBytes } from "./format.ts";
import type { EnergyCurrency, HostSample, LiveFrame, LiveInit, LlmTotalsPoint } from "@portal/core";

/** How much history the charts show. */
export const HISTORY_MS = 60_000;

const fixed = (digits: number) => new Intl.NumberFormat("en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const integer = fixed(0);
const oneDecimal = fixed(1);
const twoDecimals = fixed(2);
const threeDecimals = fixed(3);
const fourDecimals = fixed(4);

/** A rate or reading: one decimal below 10, whole numbers (with thousands separators) above. "—" when unknown. */
export function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Math.abs(value) < 10 ? oneDecimal.format(value) : integer.format(value);
}

/** "54 °C" */
export function formatTemp(celsius: number | null | undefined): string {
  return celsius === null || celsius === undefined ? "—" : `${integer.format(celsius)} °C`;
}

/** "3.12 GHz", "850 MHz" */
export function formatClock(mhz: number | null | undefined): string {
  if (mhz === null || mhz === undefined) return "—";
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${integer.format(mhz)} MHz`;
}

/** "156 W", "6.1 W" */
export function formatWatts(watts: number | null | undefined): string {
  return watts === null || watts === undefined ? "—" : `${formatNumber(watts)} W`;
}

/** "12%" */
export function formatPercent(percent: number | null | undefined): string {
  return percent === null || percent === undefined || !Number.isFinite(percent) ? "—" : `${integer.format(Math.max(0, percent))}%`;
}

/** Memory bandwidth in decimal units, as hardware is rated: "165 GB/s", "820 MB/s". */
export function formatBandwidth(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e9) return `${formatNumber(bytesPerSecond / 1e9)} GB/s`;
  return `${integer.format(bytesPerSecond / 1e6)} MB/s`;
}

/** A transfer rate in decimal units, as networks and disks are rated: "12.4 MB/s", "820 kB/s", "0 B/s". */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return "—";
  const value = Math.max(0, bytesPerSecond);
  if (value >= 1e9) return `${formatNumber(value / 1e9)} GB/s`;
  if (value >= 1e6) return `${formatNumber(value / 1e6)} MB/s`;
  if (value >= 1e3) return `${formatNumber(value / 1e3)} kB/s`;
  return `${integer.format(value)} B/s`;
}

/** A short span: "850 ms", "8.2 s", "45 s", "2m 05s", "1h 04m". */
export function formatElapsed(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1000) return `${integer.format(value)} ms`;
  if (value < 10_000) return `${oneDecimal.format(value / 1000)} s`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "113 / 124 GiB", the unit once when both share it; "228 KiB / 8.0 GiB" when not. */
export function formatBytesOf(part: number, whole: number): string {
  const [a, b] = [formatBytes(part), formatBytes(whole)];
  const unit = b.slice(b.indexOf(" "));
  return a.endsWith(unit) ? `${a.slice(0, -unit.length)} / ${b}` : `${a} / ${b}`;
}

/** A clock that reads 0 (an iGPU asleep), or that portal-hostd leaves null while the cores idle, shows as idle. */
export function formatClockOrIdle(mhz: number | null | undefined, usage: number | null | undefined): string {
  if (mhz === 0 || ((mhz === null || mhz === undefined) && usage !== null && usage !== undefined)) return "idle";
  return formatClock(mhz);
}

/** Memory a sample reports as free: what MemAvailable says (cache that can be dropped counts as free). */
export function memoryFree(sample: HostSample): { bytes: number; percent: number } {
  const { totalBytes, availableBytes } = sample.memory;
  return { bytes: availableBytes, percent: totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0 };
}

/** Used share of a whole, in percent; null when the whole is unknown. */
export function usedPercent(used: number | null, total: number | null | undefined): number | null {
  if (used === null || !total) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** Energy without its unit: three decimals for a day's few kWh ("0.214"), fewer as it grows ("41.75", "1,204.5"). */
export function formatKwh(kwh: number | null): string {
  if (kwh === null || !Number.isFinite(kwh)) return "—";
  const value = Math.max(0, kwh);
  return (value < 10 ? threeDecimals : value < 100 ? twoDecimals : value < 1000 ? oneDecimal : integer).format(value);
}

const money: Record<EnergyCurrency, Intl.NumberFormat> = {
  USD: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
  EUR: new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }),
};
// Prices per kWh as their sources publish them: EIA in cents to a hundredth, Eurostat in euros to four places.
const unitPrice: Record<EnergyCurrency, { unit: string; scale: number; format: Intl.NumberFormat }> = {
  USD: { unit: "¢/kWh", scale: 100, format: twoDecimals },
  EUR: { unit: "€/kWh", scale: 1, format: fourDecimals },
};

/** An amount with its currency: "$1.18", "€0.02"; "<$0.01" for a cost too small to show in cents. "—" when unknown. */
export function formatMoney(amount: number | null, currency: EnergyCurrency | null): string {
  if (amount === null || !Number.isFinite(amount) || !currency) return "—";
  const format = money[currency];
  return amount > 0 && amount < 0.005 ? `<${format.format(0.01)}` : format.format(Math.max(0, amount));
}

/**
 * A small cost, such as one session's: dollars under one in cents ("0.47¢", "12.3¢"), euros under one to four or
 * three places ("€0.0047", "€0.047"), like their prices per kWh; from one up, as formatMoney. "—" when unknown.
 */
export function formatCost(amount: number | null, currency: EnergyCurrency | null): string {
  if (amount === null || !Number.isFinite(amount) || !currency) return "—";
  const value = Math.max(0, amount);
  if (value >= 1) return formatMoney(value, currency);
  if (currency === "USD") return `${(value < 0.1 ? twoDecimals : oneDecimal).format(value * 100)}¢`;
  return `€${(value < 0.01 ? fourDecimals : threeDecimals).format(value)}`;
}

/** Energy in watt-hours, with its unit: "0.71 Wh", "31.4 Wh", "882 Wh", then "1.24 kWh". */
export function formatWh(wh: number): string {
  const value = Math.max(0, wh);
  if (value >= 1000) return `${twoDecimals.format(value / 1000)} kWh`;
  return `${(value < 10 ? twoDecimals : value < 100 ? oneDecimal : integer).format(value)} Wh`;
}

/** The unit prices are shown in: "¢/kWh" for dollars, "€/kWh" for euros. */
export function priceUnit(currency: EnergyCurrency): string {
  return unitPrice[currency].unit;
}

/** A price per kWh (in currency units) in its unit, without it: 0.1499 USD is "14.99" (¢), 0.3618 EUR "0.3618". */
export function formatUnitPrice(price: number | null | undefined, currency: EnergyCurrency | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price) || !currency) return "—";
  const { scale, format } = unitPrice[currency];
  return format.format(price * scale);
}

const HALVES = { "1": "Jan to Jun", "2": "Jul to Dec" } as const;

/** A price's period: "2026-08" is "August 2026", Eurostat's "2026-S1" "Jan to Jun 2026". */
export function formatPricePeriod(period: string): string {
  const half = /^(\d{4})-S([12])$/.exec(period);
  if (half) return `${HALVES[half[2] as "1" | "2"]} ${half[1]}`;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? formatMonth(period) : period;
}

// Days and months are calendar dates (YYYY-MM-DD, YYYY-MM): read and shown in UTC so no time zone moves them.
const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** "Mon, Nov 16" */
export function formatDay(day: string): string {
  return dayFormat.format(new Date(`${day}T00:00:00Z`));
}

/** "November 2026" */
export function formatMonth(month: string): string {
  return monthFormat.format(new Date(`${month}-01T00:00:00Z`));
}

/** Round axis ticks from 0 that cover `max` in about three steps of 1, 2, 2.5 or 5 × 10ⁿ: 0 / 0.5 / 1 / 1.5. */
export function axisTicks(max: number): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw) ?? 10 * power;
  const steps = Math.ceil(max / step - 1e-9);
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/** An axis label with as many decimals as the ticks' step needs, so 0.001 and 0.002 don't both read "0". */
export function formatAxisTick(value: number, ticks: readonly number[]): string {
  const step = ticks[1] ?? 1;
  let decimals = 0;
  while (decimals < 6 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-9) decimals++;
  return value.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Every day of a YYYY-MM month, YYYY-MM-DD, in order. */
export function daysOfMonth(month: string): string[] {
  const [year = 1970, index = 1] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Adds up what is known: null only when every part is. */
export function sumKnown(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/** The `count` days that end with `day`, YYYY-MM-DD, in order. */
export function daysUntil(day: string, count: number): string[] {
  const end = Date.parse(`${day}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Appends `items` (with a `t`) to `history`, keeping only the newest HISTORY_MS and never going back in time.
 * Returns `history` itself when nothing is new.
 */
export function appendHistory<T extends { t: number }>(history: readonly T[], items: readonly T[]): readonly T[] {
  let last = history.at(-1)?.t ?? -Infinity;
  const added: T[] = [];
  for (const item of items) {
    if (item.t <= last) continue;
    added.push(item);
    last = item.t;
  }
  if (added.length === 0) return history;
  const next = [...history, ...added];
  const from = next.findIndex((item) => item.t >= last - HISTORY_MS);
  return from > 0 ? next.slice(from) : next;
}

export interface LiveHistory {
  portal: readonly HostSample[];
  llm: readonly HostSample[];
  tokens: readonly LlmTotalsPoint[];
}

export const EMPTY_HISTORY: LiveHistory = { portal: [], llm: [], tokens: [] };

/** The history a new stream starts with. */
export function historyFromInit(init: LiveInit): LiveHistory {
  return { portal: appendHistory([], init.history.portal), llm: appendHistory([], init.history.llm), tokens: appendHistory([], init.llmHistory) };
}

/** The history after a frame: each server's newest reading, and the LLM totals at the frame's time. */
export function historyWithFrame(history: LiveHistory, frame: LiveFrame): LiveHistory {
  const portal = frame.hosts.portal.sample;
  const llm = frame.hosts.llm.sample;
  return {
    portal: portal ? appendHistory(history.portal, [portal]) : history.portal,
    llm: llm ? appendHistory(history.llm, [llm]) : history.llm,
    tokens: appendHistory(history.tokens, [{ t: frame.t, readTps: frame.llm.totals.readTps, writeTps: frame.llm.totals.writeTps }]),
  };
}
