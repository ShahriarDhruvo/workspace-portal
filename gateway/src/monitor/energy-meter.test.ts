// Local days in a zone with daylight saving time (node --test runs each file in a process of its own).
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { hostDaily, type PortalDb } from "@portal/core";
import { closeServer, FakeMeter, listenLocal, quiet, tempDb } from "../../test/fakes.ts";
import { EnergyMeter, splitByDay } from "./energy-meter.ts";
import { HostdClient, HostdError } from "./hostd.ts";

const at = (day: number, hours: number, minutes = 0, seconds = 0): number => new Date(2026, 10, day, hours, minutes, seconds).getTime();

function rows(db: PortalDb): Array<{ day: string; role: string; energyWh: number | null; rxBytes: number; txBytes: number }> {
  return db
    .select({ day: hostDaily.day, role: hostDaily.role, energyWh: hostDaily.energyWh, rxBytes: hostDaily.rxBytes, txBytes: hostDaily.txBytes })
    .from(hostDaily)
    .orderBy(hostDaily.day, hostDaily.role)
    .all()
    .map((row) => ({ ...row, energyWh: row.energyWh === null ? null : Math.round(row.energyWh * 1e6) / 1e6 }));
}

test("books the increase of each reading, a restarted hostd's totals from zero, and a counter reset as new", async () => {
  const db = tempDb();
  let now = at(16, 10);
  const portal = new FakeMeter("a", now - 60_000);
  portal.set({ energyJ: 3600, rxBytes: 1000, txBytes: 500 });
  const meter = new EnergyMeter({ db, sources: { portal }, log: quiet, now: () => now });

  await meter.poll(); // the first reading ever: everything since hostd started
  assert.deepEqual(meter.today("portal"), { day: "2026-11-16", energyWh: 1, rxBytes: 1000, txBytes: 500 });
  now += 30_000;
  portal.set({ energyJ: 7200, rxBytes: 1500, txBytes: 600 });
  await meter.poll();
  assert.deepEqual(meter.today("portal"), { day: "2026-11-16", energyWh: 2, rxBytes: 1500, txBytes: 600 });

  now += 30_000;
  portal.set({ instance: "b", startedAt: now - 10_000, energyJ: 360, rxBytes: 100, txBytes: 0 });
  await meter.poll();
  assert.deepEqual(meter.today("portal"), { day: "2026-11-16", energyWh: 2.1, rxBytes: 1600, txBytes: 600 });

  now += 30_000;
  portal.set({ energyJ: 720, rxBytes: 50, txBytes: 10 }); // rx went back within one instance: a reset
  await meter.poll();
  assert.deepEqual(rows(db), [{ day: "2026-11-16", role: "portal", energyWh: 2.2, rxBytes: 1650, txBytes: 610 }]);
  assert.equal(meter.today("llm"), null, "a server that isn't set up has no totals");
});

test("an interval over local midnight is split in proportion to time, a long one over every day it spans", async () => {
  const db = tempDb();
  let now = at(15, 23, 59, 40);
  const llm = new FakeMeter("x", now);
  const meter = new EnergyMeter({ db, sources: { llm }, log: quiet, now: () => now });
  await meter.poll();
  now = at(16, 0, 0, 20);
  llm.set({ energyJ: 7200, rxBytes: 1001, txBytes: 2 });
  await meter.poll();
  assert.deepEqual(rows(db), [
    { day: "2026-11-15", role: "llm", energyWh: 1, rxBytes: 501, txBytes: 1 },
    { day: "2026-11-16", role: "llm", energyWh: 1, rxBytes: 500, txBytes: 1 },
  ]);
  assert.deepEqual(meter.today("llm"), { day: "2026-11-16", energyWh: 1, rxBytes: 500, txBytes: 1 });

  // The gateway was away from the 16th 12:00 to the 18th 12:00; the same hostd kept counting.
  now = at(16, 12);
  llm.set({ energyJ: 7200 + 3600, rxBytes: 1001, txBytes: 2 });
  await meter.poll();
  now = at(18, 12);
  llm.set({ energyJ: 7200 + 3600 + 4 * 3600, rxBytes: 1001 + 4000, txBytes: 2 });
  await meter.poll();
  assert.deepEqual(rows(db).slice(1), [
    { day: "2026-11-16", role: "llm", energyWh: 2 + 1, rxBytes: 1500, txBytes: 1 },
    { day: "2026-11-17", role: "llm", energyWh: 2, rxBytes: 2000, txBytes: 0 },
    { day: "2026-11-18", role: "llm", energyWh: 1, rxBytes: 1000, txBytes: 0 },
  ]);
});

test("splitByDay follows local days, daylight saving time included", () => {
  assert.deepEqual(splitByDay(at(16, 9), at(16, 10)), [{ day: "2026-11-16", share: 1 }]);
  assert.deepEqual(splitByDay(at(16, 10), at(16, 9)), [{ day: "2026-11-16", share: 1 }], "a backward span: the day of its end");
  // 1 November 2026 has 25 hours in New York.
  const parts = splitByDay(at(0, 12) /* 31 October */, at(2, 12));
  assert.deepEqual(
    parts.map((part) => [part.day, Math.round(part.share * 49 * 1e9) / 1e9]),
    [
      ["2026-10-31", 12],
      ["2026-11-01", 25],
      ["2026-11-02", 12],
    ],
  );
});

test("a server whose power can't be measured keeps energy_wh NULL; its traffic still counts", async () => {
  const db = tempDb();
  let now = at(16, 8);
  const portal = new FakeMeter("p", now);
  const llm = new FakeMeter("l", now);
  portal.set({ energyJ: null });
  const meter = new EnergyMeter({ db, sources: { portal, llm }, log: quiet, now: () => now });
  await meter.poll();
  now += 30_000;
  portal.set({ rxBytes: 300, txBytes: 30 });
  llm.set({ energyJ: 36, rxBytes: null, txBytes: null });
  await meter.poll();
  assert.deepEqual(rows(db), [
    { day: "2026-11-16", role: "llm", energyWh: 0.01, rxBytes: 0, txBytes: 0 },
    { day: "2026-11-16", role: "portal", energyWh: null, rxBytes: 300, txBytes: 30 },
  ]);
  assert.equal(meter.today("portal")?.energyWh, null);
});

test("an unreachable hostd is skipped and logged once per change; nothing is lost", async () => {
  const db = tempDb();
  let now = at(16, 8);
  const portal = new FakeMeter("p", now);
  const llm = new FakeMeter("l", now);
  const lines: string[] = [];
  const record = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  const meter = new EnergyMeter({ db, sources: { portal, llm }, log: { info: record("info"), warn: record("warn"), error: record("error") }, now: () => now });
  await meter.poll();

  llm.error = new HostdError(null, "unreachable", "http://fake-hostd:9180: connect ECONNREFUSED");
  for (let i = 1; i <= 3; i++) {
    now += 30_000;
    portal.set({ rxBytes: 100 * i });
    llm.set({ energyJ: 3600 * i });
    await meter.poll();
  }
  assert.equal(meter.today("portal")?.rxBytes, 300, "the other server goes on");
  assert.equal(meter.today("llm")?.energyWh, 0);
  llm.error = null;
  now += 30_000;
  await meter.poll();
  assert.equal(meter.today("llm")?.energyWh, 3, "what it counted meanwhile arrives with the next reading");
  assert.deepEqual(lines, ["warn: energy meter: portal-hostd unavailable", "info: energy meter: reading again"]);

  llm.set({ energyJ: "lots" as unknown as number });
  now += 30_000;
  await meter.poll();
  assert.equal(meter.today("llm")?.energyWh, 3, "an answer of another shape books nothing");
});

test("a restarted gateway goes on from the last stored reading and today's row", async () => {
  const db = tempDb();
  let now = at(16, 8);
  const llm = new FakeMeter("l", now - 3_600_000);
  llm.set({ energyJ: 36_000, rxBytes: 10, txBytes: 20 });
  await new EnergyMeter({ db, sources: { llm }, log: quiet, now: () => now }).poll();

  now += 60_000;
  const again = new EnergyMeter({ db, sources: { llm }, log: quiet, now: () => now });
  assert.deepEqual(again.today("llm"), { day: "2026-11-16", energyWh: 10, rxBytes: 10, txBytes: 20 }, "before its first poll");
  llm.set({ energyJ: 39_600, rxBytes: 15, txBytes: 20 });
  await again.poll();
  assert.deepEqual(again.today("llm"), { day: "2026-11-16", energyWh: 11, rxBytes: 15, txBytes: 20 });

  now = at(17, 0, 0, 10);
  assert.equal(again.today("llm"), null, "a new day has no totals until the next reading");
});

test("polls GET /v1/meter through HostdClient with the token, every pollMs, until stopped", async () => {
  const token = "m".repeat(40);
  const answers: string[] = [];
  const server = http.createServer((req, res) => {
    answers.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${token}`}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ instance: "i", startedAt: Date.now(), t: Date.now(), energyJ: 3.6 * answers.length, rxBytes: 1, txBytes: 2 }));
  });
  const port = await listenLocal(server);
  const db = tempDb();
  const meter = new EnergyMeter({ db, sources: { portal: new HostdClient({ url: `http://127.0.0.1:${port}`, token }) }, log: quiet, pollMs: 20 });
  try {
    meter.start();
    const deadline = Date.now() + 5_000;
    while (answers.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    meter.stop();
    await meter.poll();
    assert.ok(answers.length >= 3);
    assert.equal(answers[0], "GET /v1/meter true");
    assert.equal(meter.today("portal")?.rxBytes, 1);
  } finally {
    meter.stop();
    await closeServer(server);
  }
});
