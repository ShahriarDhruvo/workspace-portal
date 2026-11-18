import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeterSource } from "./energy-meter.ts";
import type { MeterReading } from "./hostd.ts";
import { LlmEnergy } from "./llm-energy.ts";
import { quiet } from "../../test/fakes.ts";
import type { EnergyShare } from "./session-log.ts";

class FakeMeter implements MeterSource {
  readonly url = "http://llm:9180";
  reading: MeterReading = { instance: "a", startedAt: 0, t: 0, energyJ: 0, rxBytes: 0, txBytes: 0 };
  calls = 0;
  async get<T>(): Promise<T> {
    this.calls++;
    return { ...this.reading } as T;
  }
  /** The meter's next 2 s update: `watts` over the time since the last one. */
  tick(t: number, watts: number): void {
    this.reading = { ...this.reading, t, energyJ: this.reading.energyJ! + (watts * (t - this.reading.t)) / 1000 };
  }
}

function setup() {
  const meter = new FakeMeter();
  const clock = { now: 0 };
  const shares: EnergyShare[] = [];
  const energy = new LlmEnergy({ source: meter, onShares: (list) => shares.push(...list), log: quiet, now: () => clock.now, readMs: 60_000 });
  const total = (sessionId: number) => shares.filter((s) => s.sessionId === sessionId).reduce((sum, s) => sum + s.joules, 0);
  return { meter, clock, shares, energy, total };
}

test("each stretch's energy goes to the requests that ran in it, by how long each ran", async () => {
  const { meter, clock, energy, total } = setup();
  clock.now = 100;
  energy.started(1, 7, 100);
  await energy.read(); // the busy spell's first reading: where the first stretch starts
  energy.started(2, 8, 1_000);
  meter.tick(2_000, 120);
  clock.now = 2_000;
  await energy.read();
  // 0 to 2 s: 240 J; request 1 ran 1.9 s of it, request 2 1 s.
  assert.equal(Math.round(total(7)), Math.round((240 * 1_900) / 2_900));
  assert.equal(Math.round(total(8)), Math.round((240 * 1_000) / 2_900));

  energy.ended(1, 3_000);
  energy.ended(2, 3_000);
  meter.tick(4_000, 100);
  clock.now = 4_000;
  await energy.read();
  // 2 to 4 s: 200 J, both ran 1 s of it; after that nothing is read (idle draw goes to no one).
  assert.equal(Math.round(total(7) + total(8)), 440);
  const calls = meter.calls;
  meter.tick(6_000, 10);
  await energy.read();
  assert.equal(Math.round(total(7) + total(8)), 440, "nothing runs: the reading only starts no stretch");
  assert.ok(meter.calls > calls);
});

test("a session's time counts its parallel requests once, so its energy over it is its draw", async () => {
  const { meter, clock, shares, energy } = setup();
  energy.started(1, 7, 0);
  energy.started(2, 7, 500);
  await energy.read();
  energy.ended(1, 1_500);
  energy.ended(2, 2_000);
  meter.tick(2_000, 120);
  clock.now = 2_000;
  await energy.read();
  // One session alone, two requests over 0 to 2 s: all 240 J, over 2 s (120 W), not over 3.5 s of requests.
  assert.deepEqual(shares, [{ sessionId: 7, joules: 240, ms: 2_000 }]);
});

test("a restarted hostd, an unmeasurable server or a clock far off share nothing wrong", async () => {
  const { meter, clock, energy, total, shares } = setup();
  energy.started(1, 7, 0);
  await energy.read();
  meter.reading = { ...meter.reading, instance: "b", t: 2_000, energyJ: 5 };
  clock.now = 2_000;
  await energy.read();
  assert.equal(shares.length, 0, "a new instance starts the counting again");
  meter.tick(4_000, 50);
  clock.now = 4_000;
  await energy.read();
  assert.equal(Math.round(total(7)), 100);

  // The LLM server's clock is an hour off: the stretch is bounded by the gateway's own clock instead.
  meter.reading = { ...meter.reading, t: 3_600_000 + 6_000, energyJ: meter.reading.energyJ! + 100 };
  clock.now = 6_000;
  await energy.read();
  assert.equal(Math.round(total(7)), 200);

  meter.reading = { ...meter.reading, energyJ: null };
  clock.now = 8_000;
  await energy.read();
  energy.ended(1, 8_000);
  assert.equal(Math.round(total(7)), 200, "power not measurable: nothing more to share");
  energy.stop();
});
