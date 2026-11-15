import { test } from "node:test";
import assert from "node:assert/strict";
import { RegistryError, type NpmRegistry } from "./npm-registry.ts";
import { ReleaseCache, RELEASES_RETRY_MS, RELEASES_TTL_MS } from "./release-cache.ts";

const QWEN = "@qwen-code/qwen-code";
const DSH = "@deepseek-ai/dsh";

function fakeRegistry() {
  const state = {
    tags: { [QWEN]: { latest: "0.27.4" }, [DSH]: { latest: "0.2.2-rc.1" } } as Record<string, Record<string, string>>,
    down: false,
    calls: [] as string[],
    gate: null as Promise<void> | null,
  };
  const registry: NpmRegistry = {
    async distTags(name) {
      state.calls.push(name);
      await state.gate;
      if (state.down) throw new RegistryError("The npm registry is unreachable (fetch failed).");
      return { ...state.tags[name] };
    },
    async hasVersion() {
      return true;
    },
  };
  return { state, registry };
}

test("answers are kept for 10 minutes; refresh asks again at once", async () => {
  const clock = { now: 1_000_000 };
  const { state, registry } = fakeRegistry();
  const cache = new ReleaseCache({ registry, now: () => clock.now });
  const first = await cache.snapshot([QWEN, DSH]);
  assert.deepEqual(Object.fromEntries(first.tags), { [QWEN]: { latest: "0.27.4" }, [DSH]: { latest: "0.2.2-rc.1" } });
  assert.deepEqual([first.checkedAt, first.error], [1_000_000, null]);
  assert.equal(state.calls.length, 2);

  state.tags[QWEN] = { latest: "0.28.0" };
  clock.now += RELEASES_TTL_MS - 1;
  assert.deepEqual((await cache.snapshot([QWEN, DSH])).tags.get(QWEN), { latest: "0.27.4" }, "still fresh");
  assert.equal(state.calls.length, 2);
  const refreshed = await cache.snapshot([QWEN, DSH], { refresh: true });
  assert.deepEqual(refreshed.tags.get(QWEN), { latest: "0.28.0" });
  assert.equal(refreshed.checkedAt, clock.now);
  clock.now += RELEASES_TTL_MS;
  await cache.snapshot([QWEN, DSH]);
  assert.equal(state.calls.length, 6, "stale after 10 minutes");
});

test("an outage keeps the last answers, reports the error and retries after a minute", async () => {
  const clock = { now: 1_000_000 };
  const { state, registry } = fakeRegistry();
  const cache = new ReleaseCache({ registry, now: () => clock.now });
  await cache.snapshot([QWEN, DSH]);
  state.down = true;
  clock.now += RELEASES_TTL_MS;
  const down = await cache.snapshot([QWEN, DSH]);
  assert.equal(down.error, "The npm registry is unreachable (fetch failed).");
  assert.equal(down.checkedAt, 1_000_000, "when it last worked");
  assert.deepEqual(down.tags.get(QWEN), { latest: "0.27.4" }, "the stale answer");
  const calls = state.calls.length;
  clock.now += RELEASES_RETRY_MS - 1;
  assert.equal((await cache.snapshot([QWEN, DSH])).error, down.error);
  assert.equal(state.calls.length, calls, "polls don't hammer a registry that is down");
  state.down = false;
  clock.now += 1;
  const back = await cache.snapshot([QWEN, DSH]);
  assert.deepEqual([back.error, back.checkedAt], [null, clock.now]);
});

test("a registry that was never reached leaves the channels unknown", async () => {
  const { state, registry } = fakeRegistry();
  state.down = true;
  const snapshot = await new ReleaseCache({ registry }).snapshot([QWEN]);
  assert.deepEqual([snapshot.tags.size, snapshot.checkedAt], [0, null]);
  assert.match(snapshot.error!, /unreachable/);
});

test("concurrent callers share one check; fresh() bypasses and updates the cache", async () => {
  const { state, registry } = fakeRegistry();
  let open!: () => void;
  state.gate = new Promise((resolve) => (open = resolve));
  const cache = new ReleaseCache({ registry });
  const both = Promise.all([cache.snapshot([QWEN]), cache.snapshot([QWEN], { refresh: true })]);
  open();
  await both;
  assert.deepEqual(state.calls, [QWEN]);
  state.tags[QWEN] = { latest: "0.28.0", next: "0.29.0-rc.1" };
  assert.deepEqual(await cache.fresh(QWEN), { latest: "0.28.0", next: "0.29.0-rc.1" });
  assert.deepEqual((await cache.snapshot([QWEN])).tags.get(QWEN), { latest: "0.28.0", next: "0.29.0-rc.1" });
  state.down = true;
  await assert.rejects(cache.fresh(QWEN), RegistryError);
});
