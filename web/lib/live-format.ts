// Formatting and history for Admin > Usage: the live view and the energy card. Pure; unit tested.
import { formatBytes } from "./format.ts";
import type { HostSample, LiveFrame, LiveInit, LlmTotalsPoint } from "./live-types.ts";

/** How much history the charts show. */
export const HISTORY_MS = 60_000;

const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A rate or reading: one decimal below 10, whole numbers (with thousands separators) above. "—" when unknown. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
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
export function formatBandwidth(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return "—";
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

/** A short span: "850 ms", "8.2 s", "45 s", "2m 05s", "1h 04m". "—" when unknown. */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
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

/** A clock that reads 0 (an iGPU asleep) or is left out while the cores idle (portal-hostd) shows as idle. */
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
export function usedPercent(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used === null || used === undefined || !total) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

const kwh3 = new Intl.NumberFormat("en", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const kwh2 = new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kwh1 = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const cents = new Intl.NumberFormat("en", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Energy without its unit: three decimals for a day's few kWh ("0.214"), fewer as it grows ("41.75", "1,204.5"). */
export function formatKwh(kwh: number | null | undefined): string {
  if (kwh === null || kwh === undefined || !Number.isFinite(kwh)) return "—";
  const value = Math.max(0, kwh);
  return (value < 10 ? kwh3 : value < 100 ? kwh2 : value < 1000 ? kwh1 : integer).format(value);
}

/** Dollars and cents: "$1.18", "$0.02"; "<$0.01" for a cost too small to show in cents. */
export function formatUsd(dollars: number | null | undefined): string {
  if (dollars === null || dollars === undefined || !Number.isFinite(dollars)) return "—";
  return dollars > 0 && dollars < 0.005 ? "<$0.01" : usd.format(Math.max(0, dollars));
}

/** A price per kWh in cents, to a thousandth as utilities publish them: "14.258". */
export function formatCents(centsPerKwh: number | null | undefined): string {
  return centsPerKwh === null || centsPerKwh === undefined || !Number.isFinite(centsPerKwh) ? "—" : cents.format(centsPerKwh);
}

// Days and months are calendar dates (YYYY-MM-DD, YYYY-MM): read and shown in UTC so no time zone moves them.
const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const longDayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** "Mon, Nov 16" */
export function formatDay(day: string): string {
  return dayFormat.format(new Date(`${day}T00:00:00Z`));
}

/** "Nov 16, 2026" */
export function formatDate(day: string): string {
  return longDayFormat.format(new Date(`${day}T00:00:00Z`));
}

/** "November 2026" */
export function formatMonth(month: string): string {
  return monthFormat.format(new Date(`${month}-01T00:00:00Z`));
}

/** Round axis ticks from 0 that cover `max` in about `intervals` steps of 1, 2, 2.5 or 5 × 10ⁿ: 0 / 0.5 / 1 / 1.5. */
export function axisTicks(max: number, intervals = 3): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / intervals;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw) ?? 10 * power;
  const steps = Math.ceil(max / step - 1e-9);
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/** Every day of a YYYY-MM month, YYYY-MM-DD, in order. */
export function daysOfMonth(month: string): string[] {
  const [year = 1970, index = 1] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * Appends `items` (with a `t`) to `history`, keeping only the newest `windowMs` and never going back in time.
 * Returns `history` itself when nothing is new.
 */
export function appendHistory<T extends { t: number }>(history: readonly T[], items: readonly T[], windowMs = HISTORY_MS): readonly T[] {
  let last = history.at(-1)?.t ?? -Infinity;
  const added: T[] = [];
  for (const item of items) {
    if (item.t <= last) continue;
    added.push(item);
    last = item.t;
  }
  if (added.length === 0) return history;
  const next = [...history, ...added];
  const from = next.findIndex((item) => item.t >= last - windowMs);
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
