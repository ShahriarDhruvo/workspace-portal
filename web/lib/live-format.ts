// Formatting and history for the admin's live view (Overview). Pure; unit tested.
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

/** Memory a sample reports as free: what MemAvailable says (cache that can be dropped counts as free). */
export function memoryFree(sample: HostSample): { bytes: number; percent: number } {
  const { totalBytes, availableBytes } = sample.memory;
  return { bytes: availableBytes, percent: totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0 };
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
