import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmEnergy, type EnergyShare } from "./llm-energy.ts";
import { FakeMeter, quiet } from "../../test/fakes.ts";

function setup() {
  const meter = new FakeMeter();
  /** The meter's next 2 s update: `watts` over the time since the last one. */
  const tick = (t: number, watts: number): void => meter.set({ t, energyJ: meter.reading.energyJ! + (watts * (t - meter.reading.t)) / 1000 });
  const clock = { now: 0 };
  const shares: EnergyShare[] = [];
  const energy = new LlmEnergy({ source: meter, onShares: (list) => shares.push(...list), log: quiet, now: () => clock.now, readMs: 60_000 });
  const total = (sessionId: number) => shares.filter((s) => "sessionId" in s && s.sessionId === sessionId).reduce((sum, s) => sum + s.joules, 0);
  return { meter: Object.assign(meter, { tick }), clock, shares, energy, total };
}

test("each stretch's energy goes to the requests that ran in it, by how long each ran", async () => {
  const { meter, clock, energy, total } = setup();
  clock.now = 100;
  energy.started(1, { sessionId: 7 }, 100);
  await energy.read(); // the busy spell's first reading: where the first stretch starts
  energy.started(2, { sessionId: 8 }, 1_000);
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
  energy.started(1, { sessionId: 7 }, 0);
  energy.started(2, { sessionId: 7 }, 500);
  // An API key with a session's id is another owner.
  energy.started(3, { keyId: 7 }, 0);
  await energy.read();
  energy.ended(1, 1_500);
  energy.ended(2, 2_000);
  energy.ended(3, 1_000);
  meter.tick(2_000, 120);
  clock.now = 2_000;
  await energy.read();
  // 240 J over 4 s of requests: the session's two ran 3 s of them, over 2 s of time (90 W, not 60); the key's ran 1 s.
  assert.deepEqual(shares, [
    { sessionId: 7, joules: 180, ms: 2_000 },
    { keyId: 7, joules: 60, ms: 1_000 },
  ]);
});

test("a restarted hostd, an unmeasurable server or a clock far off share nothing wrong", async () => {
  const { meter, clock, energy, total, shares } = setup();
  energy.started(1, { sessionId: 7 }, 0);
  await energy.read();
  meter.reading = { ...meter.reading, instance: "b", t: 2_000, energyJ: 5 };
  clock.now = 2_000;
  await energy.read();
  assert.equal(shares.length, 0, "a new instance starts the counting again");
  meter.tick(4_000, 50);
  clock.now = 4_000;
  await energy.read();
  assert.equal(Math.round(total(7)), 100);

  // The AI server's clock is an hour off: the stretch is bounded by the gateway's own clock instead.
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
