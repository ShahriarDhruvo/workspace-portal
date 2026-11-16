import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendHistory,
  axisTicks,
  daysOfMonth,
  formatBandwidth,
  formatBytesOf,
  formatCents,
  formatClock,
  formatClockOrIdle,
  formatDate,
  formatDay,
  formatElapsed,
  formatKwh,
  formatMonth,
  formatNumber,
  formatPercent,
  formatRate,
  formatTemp,
  formatUsd,
  formatWatts,
  historyFromInit,
  historyWithFrame,
  memoryFree,
  usedPercent,
} from "./live-format.ts";
import type { HostSample, LiveFrame } from "./live-types.ts";

test("readings are short and say when they are unknown", () => {
  assert.equal(formatNumber(1370.4), "1,370");
  assert.equal(formatNumber(22.4), "22");
  assert.equal(formatNumber(7.25), "7.3");
  assert.equal(formatNumber(0), "0.0");
  assert.equal(formatNumber(null), "—");
  assert.equal(formatNumber(Number.NaN), "—");
  assert.equal(formatTemp(54.25), "54 °C");
  assert.equal(formatClock(3120), "3.12 GHz");
  assert.equal(formatClock(850), "850 MHz");
  assert.equal(formatWatts(156.2), "156 W");
  assert.equal(formatWatts(6.1), "6.1 W");
  assert.equal(formatPercent(12.6), "13%");
  assert.equal(formatPercent(-1), "0%");
  assert.equal(formatBandwidth(165e9), "165 GB/s");
  assert.equal(formatBandwidth(2.5e9), "2.5 GB/s");
  assert.equal(formatBandwidth(820e6), "820 MB/s");
  assert.equal(formatElapsed(850), "850 ms");
  assert.equal(formatElapsed(8_240), "8.2 s");
  assert.equal(formatElapsed(45_900), "45 s");
  assert.equal(formatElapsed(125_000), "2m 05s");
  assert.equal(formatElapsed(3_840_000), "1h 04m");
  for (const format of [formatTemp, formatClock, formatWatts, formatPercent, formatBandwidth, formatElapsed, formatRate]) assert.equal(format(null), "—");
});

test("network and disk rates are in decimal units, down to bytes", () => {
  assert.equal(formatRate(92.4e6), "92 MB/s");
  assert.equal(formatRate(1.25e6), "1.3 MB/s");
  assert.equal(formatRate(820e3), "820 kB/s");
  assert.equal(formatRate(4_200), "4.2 kB/s");
  assert.equal(formatRate(512), "512 B/s");
  assert.equal(formatRate(0), "0 B/s");
  assert.equal(formatRate(2.5e9), "2.5 GB/s");
  assert.equal(usedPercent(25, 100), 25);
  assert.equal(usedPercent(5, 0), null);
  assert.equal(usedPercent(null, 100), null);
});

test("energy, money and prices stay readable when tiny", () => {
  assert.equal(formatKwh(0.0144), "0.014");
  assert.equal(formatKwh(0.3), "0.300");
  assert.equal(formatKwh(41.749), "41.75");
  assert.equal(formatKwh(204.56), "204.6");
  assert.equal(formatKwh(12_045.4), "12,045");
  assert.equal(formatKwh(null), "—");
  assert.equal(formatUsd(0.0213), "$0.02");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(1234.5), "$1,234.50");
  assert.equal(formatUsd(null), "—");
  assert.equal(formatCents(14.258), "14.258");
  assert.equal(formatCents(15), "15.000");
  assert.equal(formatCents(null), "—");
});

test("days and months read the same in every time zone", () => {
  assert.equal(formatDay("2026-11-16"), "Mon, Nov 16");
  assert.equal(formatDate("2026-08-01"), "Aug 1, 2026");
  assert.equal(formatMonth("2026-11"), "November 2026");
  assert.equal(daysOfMonth("2026-11").length, 30);
  assert.equal(daysOfMonth("2028-02").at(-1), "2028-02-29");
  assert.equal(daysOfMonth("2026-12")[0], "2026-12-01");
});

test("axis ticks are round numbers from zero", () => {
  assert.deepEqual(axisTicks(1.023), [0, 0.5, 1, 1.5]);
  assert.deepEqual(axisTicks(0.9), [0, 0.5, 1]);
  assert.deepEqual(axisTicks(0.3), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(axisTicks(41), [0, 20, 40, 60]);
  assert.deepEqual(axisTicks(0), [0, 1]);
});

function sample(t: number, availableBytes = 6e9): HostSample {
  return {
    t,
    cpu: { usage: 1, mhz: null, mhzPeak: null, tempC: null, powerW: null, coreUsage: [], coreMhz: [] },
    gpu: null,
    memory: { totalBytes: 8e9, availableBytes, usedBytes: 8e9 - availableBytes, gpuBytes: null, swapTotalBytes: 0, swapUsedBytes: 0, readBps: null, writeBps: null },
    power: { watts: null, parts: { gpu: null, cpu: null, dram: null } },
    fans: [],
  };
}

test("used of total names a shared unit once; idle clocks say so", () => {
  const GIB = 1024 ** 3;
  assert.equal(formatBytesOf(113 * GIB, 124 * GIB), "113 / 124 GiB");
  assert.equal(formatBytesOf(228 * 1024, 8 * GIB), "228 KiB / 8.0 GiB");
  assert.equal(formatBytesOf(1.7 * GIB, 7.6 * GIB), "1.7 / 7.6 GiB");
  assert.equal(formatClockOrIdle(0, 0), "idle");
  assert.equal(formatClockOrIdle(null, 3), "idle");
  assert.equal(formatClockOrIdle(null, null), "—");
  assert.equal(formatClockOrIdle(606, 0), formatClock(606));
});

test("memory free is MemAvailable, with its share of the total", () => {
  assert.deepEqual(memoryFree(sample(0, 2e9)), { bytes: 2e9, percent: 25 });
});

test("history keeps the last minute, in time order, without repeats", () => {
  const times = (items: ReadonlyArray<{ t: number }>) => items.map((item) => item.t);
  const start = [sample(0), sample(500)];
  const next = appendHistory(start, [sample(500), sample(400), sample(1000)]);
  assert.deepEqual(times(next), [0, 500, 1000]);
  assert.deepEqual(times(start), [0, 500], "the old array is left alone");
  assert.equal(appendHistory(start, [sample(500)]), start, "unchanged when nothing is new");
  assert.deepEqual(times(appendHistory(next, [sample(61_000)])), [1000, 61_000]);
});

test("a frame adds each server's newest reading and the LLM totals", () => {
  const history = historyFromInit({ frameMs: 500, history: { portal: [sample(0)], llm: [] }, llmHistory: [{ t: 0, readTps: 0, writeTps: 0 }] });
  const frame = {
    t: 500,
    hosts: { portal: { role: "portal", state: "online", error: null, info: null, sample: sample(400) }, llm: { role: "llm", state: "offline", error: "x", info: null, sample: null } },
    llm: { totals: { readTps: 1370, writeTps: 22 } },
  } as unknown as LiveFrame;
  const next = historyWithFrame(history, frame);
  assert.deepEqual(next.portal.map((s) => s.t), [0, 400]);
  assert.deepEqual(next.llm, []);
  assert.deepEqual(next.tokens.at(-1), { t: 500, readTps: 1370, writeTps: 22 });
});
