import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmMonitor, pairSessions, parseSlots, readRate, updateTracks, windowRate, type SessionTrack } from "./llm-monitor.ts";
import { LlmQueue } from "../service/llm-queue.ts";
import { LlmRequests, type ActiveLlmRequest } from "./llm-requests.ts";
import { quiet } from "../../test/fakes.ts";

/** One /slots entry as gufo (llama.cpp's server) reports it, prompt text left out. */
function slot(id: number, fields: { task?: number; processing?: boolean; prompt?: number; cache?: number; processed?: number; decoded?: number } = {}): object {
  return {
    id,
    id_task: fields.task ?? -1,
    n_ctx: 131072,
    is_processing: fields.processing ?? false,
    n_prompt_tokens: fields.prompt ?? 0,
    n_prompt_tokens_cache: fields.cache ?? 0,
    n_prompt_tokens_processed: fields.processed ?? 0,
    next_token: [{ has_next_token: true, n_remain: -1, n_decoded: fields.decoded ?? 0 }],
  };
}

test("parseSlots reads llama.cpp-style sessions and refuses anything else", () => {
  assert.deepEqual(parseSlots([slot(0), slot(1, { task: 7, processing: true, prompt: 9000, cache: 1000, processed: 4096, decoded: 3 })]), [
    { id: 0, task: -1, processing: false, promptTokens: 0, cachedTokens: 0, processedTokens: 0, generatedTokens: 0 },
    { id: 1, task: 7, processing: true, promptTokens: 9000, cachedTokens: 1000, processedTokens: 4096, generatedTokens: 3 },
  ]);
  assert.deepEqual(parseSlots([]), []);
  for (const other of [null, {}, "x", [1], [{}], [{ id: -1 }], { data: [] }]) assert.equal(parseSlots(other), null, JSON.stringify(other));
});

test("tracks follow each session's progress; Read is wall-clock from admission, Write a recent window", () => {
  const tracks = new Map<string, SessionTrack>();
  const at = (t: number, slots: object[]): void => updateTracks(tracks, parseSlots(slots)!, t);
  at(0, [slot(0, { task: 5, processing: true, prompt: 10_000, cache: 2_000 })]);
  const track = tracks.get("0:5")!;
  assert.equal(readRate(track), null, "nothing read yet");
  at(500, [slot(0, { task: 5, processing: true, prompt: 10_000, cache: 2_000 })]);
  at(1000, [slot(0, { task: 5, processing: true, prompt: 10_000, cache: 2_000, processed: 4_000 })]);
  assert.equal(readRate(track), 4_000, "4000 tokens in the first second");
  at(2000, [slot(0, { task: 5, processing: true, prompt: 10_000, cache: 2_000, processed: 8_000, decoded: 1 })]);
  assert.equal(track.writingSince, 2000);
  assert.equal(readRate(track), 4_000, "the prompt was read by the time the first token came");
  at(2500, [slot(0, { task: 5, processing: true, processed: 8_000, decoded: 11 })]);
  assert.equal(windowRate(track.samples, 2500), null, "half a second is too little history");
  at(3000, [slot(0, { task: 5, processing: true, processed: 8_000, decoded: 21 })]);
  assert.equal(windowRate(track.samples, 3000), 20);
  at(6000, [slot(0, { task: 5, processing: true, processed: 8_000, decoded: 81 })]);
  assert.equal(windowRate(track.samples, 6000), 20, "samples older than the window are dropped");
  assert.equal(readRate(track), 4_000);

  // The session moves on to the next request (a new task): a new track; idle sessions are dropped.
  at(6500, [slot(0, { task: 9, processing: true, prompt: 500 }), slot(1)]);
  assert.deepEqual([...tracks.keys()], ["0:9"]);
  at(7000, [slot(0, { task: 9 })]);
  assert.equal(tracks.size, 0);
});

test("Read of a session first seen under way counts only what it reads from then on", () => {
  // The first viewer opens the Overview while a long prompt is half read (36,000 tokens in): the monitor starts now.
  const tracks = new Map<string, SessionTrack>();
  const at = (t: number, slots: object[]): void => updateTracks(tracks, parseSlots(slots)!, t);
  at(0, [slot(2, { task: 3, processing: true, prompt: 62_000, processed: 36_000 })]);
  const track = tracks.get("2:3")!;
  assert.equal(readRate(track), null, "nothing read since");
  at(500, [slot(2, { task: 3, processing: true, prompt: 62_000, processed: 36_000 })]);
  at(4000, [slot(2, { task: 3, processing: true, prompt: 62_000, processed: 37_600 })]);
  assert.equal(readRate(track), 400, "1,600 tokens in 4 s, not 37,600");
});

function track(slotId: number, task: number, firstSeen: number): SessionTrack {
  return { slot: slotId, task, firstSeen, promptTokens: 0, cachedTokens: 0, processedTokens: 0, baseTokens: 0, generatedTokens: 0, processedAt: null, writingSince: null, samples: [], requestId: null };
}

function request(id: number, userId: number, forwardedAt: number | null): ActiveLlmRequest {
  return { id, userId, queuedAt: 0, forwardedAt, firstTokenAt: null, tokens: 0 };
}

test("pairSessions pairs new sessions in task order with the oldest requests sent before them", () => {
  const a = track(2, 41, 1000);
  const b = track(0, 40, 1000);
  const c = track(1, 42, 1000);
  // Request 3 was sent after the sessions were seen: it can't be one of them.
  pairSessions([a, b, c], [request(1, 10, 900), request(2, 20, 950), request(3, 30, 1200), request(4, 40, null)]);
  assert.deepEqual([b.requestId, a.requestId, c.requestId], [1, 2, null]);

  // A pairing outlives polls; a request that ended frees its session's pairing for the next one.
  const d = track(1, 43, 1300);
  pairSessions([a, b, d], [request(2, 20, 950), request(3, 30, 1200)]);
  assert.deepEqual([b.requestId, a.requestId, d.requestId], [null, 2, 3]);
});

/** An engine whose /slots answer the test sets. */
function fakeEngine(): { fetch: typeof fetch; slots: object[] | null; status: number; calls: number; down: boolean } {
  const engine = {
    slots: [] as object[] | null,
    status: 200,
    calls: 0,
    down: false,
    fetch: (async (url: string | URL | Request) => {
      engine.calls++;
      assert.match(String(url), /\/slots$/);
      if (engine.down) throw new TypeError("fetch failed");
      if (engine.status !== 200) return new Response('{"error":{"message":"Loading model"}}', { status: engine.status });
      return new Response(engine.slots === null ? "<html>" : JSON.stringify(engine.slots), { status: 200 });
    }) as typeof fetch,
  };
  return engine;
}

function setup(): { clock: { now: number }; queue: LlmQueue; requests: LlmRequests; engine: ReturnType<typeof fakeEngine>; monitor: LlmMonitor } {
  const clock = { now: 10_000 };
  const queue = new LlmQueue(7, 2);
  const requests = new LlmRequests({ now: () => clock.now });
  const engine = fakeEngine();
  const names = new Map([
    [1, "Alice"],
    [2, "Bob"],
  ]);
  const monitor = new LlmMonitor({
    upstreamUrl: "http://llm:8080",
    apiKey: "k",
    queue,
    requests,
    names: (ids) => new Map(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id)!])),
    log: quiet,
    now: () => clock.now,
    fetch: engine.fetch,
  });
  return { clock, queue, requests, engine, monitor };
}

test("the live view joins the engine's sessions with the gateway's requests", async () => {
  const { clock, queue, requests, engine, monitor } = setup();
  const releaseA = await queue.acquire(1);
  const alice = requests.begin(1);
  alice.forwarded();
  const releaseB = await queue.acquire(2);
  const bob = requests.begin(2);
  bob.forwarded();
  clock.now += 200;
  engine.slots = [slot(0, { task: 100, processing: true, prompt: 30_000, processed: 0 }), slot(1, { task: 101, processing: true, prompt: 800, cache: 700 }), slot(2)];
  await monitor.poll();
  let live = monitor.snapshot();
  assert.deepEqual(
    { engine: live.engine, reported: live.sessionsReported, sessions: live.engineSessions, inFlight: live.inFlight, max: live.maxConcurrency },
    { engine: "ready", reported: true, sessions: 3, inFlight: 2, max: 7 },
  );
  assert.deepEqual(
    live.sessions.map((s) => [s.slot, s.userName, s.phase]),
    [
      [1, "Alice", "preparing"],
      [2, "Bob", "preparing"],
    ],
  );

  clock.now += 1000;
  engine.slots = [slot(0, { task: 100, processing: true, prompt: 30_000, processed: 4_096 }), slot(1, { task: 101, processing: true, prompt: 800, cache: 700, processed: 100, decoded: 5 })];
  for (let i = 0; i < 3; i++) {
    for (let n = 0; n < 10; n++) bob.token();
    await monitor.poll();
    clock.now += 500;
    engine.slots = [slot(0, { task: 100, processing: true, prompt: 30_000, processed: 4_096 }), slot(1, { task: 101, processing: true, prompt: 800, cache: 700, processed: 100, decoded: 5 + 10 * (i + 1) })];
  }
  await monitor.poll();
  live = monitor.snapshot();
  const [a, b] = live.sessions;
  assert.equal(a!.phase, "reading");
  assert.equal(Math.round(a!.readTps!), 4_096, "4096 tokens read in the second after admission");
  assert.equal(b!.phase, "writing");
  assert.equal(b!.writeTps, 20, "10 tokens per 500 ms");
  assert.deepEqual(live.totals, { readTps: a!.readTps, writeTps: 20 }, "Read counts sessions still reading, Write those writing");

  // Bob's request ends: it leaves the sessions.
  bob.timings({ promptTokens: 100, cachedTokens: 700, promptMs: 50, generatedTokens: 40, generationMs: 2000 });
  bob.finish(true);
  releaseB();
  engine.slots = [slot(0, { task: 100, processing: true, prompt: 30_000, processed: 8_192 }), slot(1, { task: 101 })];
  await monitor.poll();
  live = monitor.snapshot();
  assert.deepEqual(live.sessions.map((s) => s.userName), ["Alice"]);
  alice.finish(false);
  releaseA();
});

test("the live view lists who waits in the gateway and in the engine, and survives an engine restart", async () => {
  const { clock, queue, requests, engine, monitor } = setup();
  queue.pause();
  const waiting = queue.acquire(2);
  requests.begin(2);
  const alice = requests.begin(1);
  alice.forwarded();
  clock.now += 1500;
  engine.slots = [slot(0)];
  await monitor.poll();
  let live = monitor.snapshot();
  assert.equal(live.paused, true);
  assert.deepEqual(live.waiting.map((w) => [w.userName, w.stage]), [
    ["Bob", "portal"],
    ["Alice", "engine"],
  ]);
  assert.deepEqual(live.sessions, []);

  engine.status = 503;
  await monitor.poll();
  assert.equal(monitor.snapshot().engine, "loading");
  // Behind llama-swap, while the image models run or the LLM starts again.
  engine.status = 409;
  await monitor.poll();
  live = monitor.snapshot();
  assert.deepEqual([live.engine, live.sessionsReported, live.engineSessions], ["unloaded", false, null]);
  engine.down = true;
  await monitor.poll();
  live = monitor.snapshot();
  assert.deepEqual([live.engine, live.sessionsReported, live.engineSessions], ["offline", false, null]);
  queue.resume();
  (await waiting)();
});

test("behind llama-swap the sessions come from LLM_SLOTS_PATH, which never starts the LLM", async () => {
  const urls: string[] = [];
  const monitor = new LlmMonitor({
    upstreamUrl: "http://llm:8080",
    slotsPath: "/upstream/qwen3.8-flash-next/slots",
    apiKey: "",
    queue: new LlmQueue(3, 2),
    requests: new LlmRequests({ now: () => 0 }),
    names: () => new Map(),
    log: quiet,
    now: () => 0,
    fetch: (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("model qwen3.8-flash-next is not loaded; path matches upstream.ignorePaths", { status: 409 });
    }) as typeof fetch,
  });
  await monitor.poll();
  assert.deepEqual(urls, ["http://llm:8080/upstream/qwen3.8-flash-next/slots"]);
  assert.equal(monitor.snapshot().engine, "unloaded");
});

test("without /slots (another kind of server) the rows come from the gateway's own count", async () => {
  const { clock, requests, engine, monitor } = setup();
  engine.slots = null;
  const alice = requests.begin(1);
  alice.forwarded();
  await monitor.poll();
  for (let i = 0; i < 4; i++) {
    clock.now += 500;
    for (let n = 0; n < 15; n++) alice.token();
    await monitor.poll();
  }
  const live = monitor.snapshot();
  assert.deepEqual([live.engine, live.sessionsReported], ["ready", false]);
  assert.deepEqual(live.sessions.map((s) => [s.slot, s.userName, s.phase, s.generatedTokens, s.writeTps]), [[null, "Alice", "writing", 60, 30]]);
  alice.finish(true);
});

test("start polls every half second until stop", async () => {
  const { engine, monitor } = setup();
  monitor.start();
  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  monitor.stop();
  const calls = engine.calls;
  assert.ok(calls >= 2 && calls <= 4, `polled ${calls} times`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(engine.calls, calls, "no polls after stop");
});
