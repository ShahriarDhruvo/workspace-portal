import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmQueue, type ReleaseSlot } from "./llm-queue.ts";

/** Starts an acquire and records when (in grant order) it was granted. */
function track(queue: LlmQueue, userId: number, order: string[], label: string, signal?: AbortSignal) {
  const state: { release: ReleaseSlot | null; error: unknown } = { release: null, error: null };
  const promise = queue.acquire(userId, signal).then(
    (release) => {
      order.push(label);
      state.release = release;
    },
    (error: unknown) => {
      state.error = error;
    },
  );
  return { state, promise };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the global limit queues the rest in arrival order", async () => {
  const queue = new LlmQueue(2, 5);
  const order: string[] = [];
  const calls = ["a", "b", "c", "d"].map((label, i) => track(queue, i + 1, order, label));
  await settle();
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(queue.inFlight, 2);
  assert.equal(queue.queued, 2);

  calls[0]!.state.release!();
  await settle();
  assert.deepEqual(order, ["a", "b", "c"]);
  calls[1]!.state.release!();
  await settle();
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(queue.queued, 0);
});

test("the per-user limit lets other users go ahead without reordering anyone's own requests", async () => {
  const queue = new LlmQueue(3, 1);
  const order: string[] = [];
  const a1 = track(queue, 1, order, "a1");
  const a2 = track(queue, 1, order, "a2");
  const a3 = track(queue, 1, order, "a3");
  track(queue, 2, order, "b1");
  await settle();
  assert.deepEqual(order, ["a1", "b1"]);
  assert.equal(queue.inFlightFor(1), 1);
  assert.equal(queue.pendingFor(1), 3, "in flight plus queued");
  assert.equal(queue.pendingFor(2), 1);

  a1.state.release!();
  await settle();
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  a2.state.release!();
  await settle();
  assert.deepEqual(order, ["a1", "b1", "a2", "a3"]);
  a3.state.release!();
  assert.equal(queue.pendingFor(1), 0);
});

test("aborting a queued request removes it and leaves the slot to the next one", async () => {
  const queue = new LlmQueue(1, 1);
  const order: string[] = [];
  const first = track(queue, 1, order, "first");
  const abort = new AbortController();
  const second = track(queue, 2, order, "second", abort.signal);
  const third = track(queue, 3, order, "third");
  await settle();
  assert.equal(queue.queued, 2);

  abort.abort(new Error("hung up"));
  await second.promise;
  assert.equal((second.state.error as Error).message, "hung up");
  assert.equal(queue.queued, 1);
  assert.equal(queue.pendingFor(2), 0);

  first.state.release!();
  await settle();
  assert.deepEqual(order, ["first", "third"]);
  third.state.release!();
  assert.equal(queue.inFlight, 0);
});

test("an already aborted signal is rejected immediately", async () => {
  const queue = new LlmQueue(1, 1);
  const abort = new AbortController();
  abort.abort(new Error("gone"));
  await assert.rejects(queue.acquire(1, abort.signal), /gone/);
  assert.equal(queue.queued, 0);
  assert.equal(queue.inFlight, 0);
});

test("releasing twice frees only one slot", async () => {
  const queue = new LlmQueue(2, 2);
  const release = await queue.acquire(1);
  await queue.acquire(1);
  release();
  release();
  assert.equal(queue.inFlight, 1);
  assert.equal(queue.inFlightFor(1), 1);
});

test("paused: nothing new is granted until resume, requests in flight carry on, waiters are listed", async () => {
  const queue = new LlmQueue(2, 2);
  const first = await queue.acquire(1);
  queue.pause();
  assert.equal(queue.paused, true);
  let granted = false;
  const waiting = queue.acquire(2).then((release) => {
    granted = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false, "a free slot is not handed out while paused");
  assert.deepEqual(queue.waiting().map((waiter) => waiter.userId), [2]);
  first();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false, "nor when one is given back");
  queue.resume();
  (await waiting)();
  assert.equal(granted, true);
  assert.equal(queue.inFlight, 0);
  assert.deepEqual(queue.waiting(), []);
});

test("held: nothing new is granted until every hold ends, and a resume does not end one", async () => {
  const queue = new LlmQueue(2, 2);
  const first = queue.hold();
  const second = queue.hold();
  assert.equal(queue.held, true);
  const order: string[] = [];
  track(queue, 1, order, "a");
  await settle();
  queue.pause();
  queue.resume();
  await settle();
  assert.deepEqual(order, [], "an engine update's resume leaves the holds in place");
  first();
  first();
  await settle();
  assert.deepEqual(order, [], "releasing one hold twice does not end the other");
  second();
  await settle();
  assert.equal(queue.held, false);
  assert.deepEqual(order, ["a"]);
});

test("acquireAlone waits for what is in flight, lets nothing behind it go first, and holds the queue once granted", async () => {
  const queue = new LlmQueue(4, 4);
  const order: string[] = [];
  const first = track(queue, 1, order, "chat-before");
  await settle();
  let alone: { release: ReleaseSlot; unhold: ReleaseSlot } | null = null;
  void queue.acquireAlone(2).then((granted) => {
    order.push("video");
    alone = granted;
  });
  track(queue, 3, order, "chat-after");
  await settle();
  assert.deepEqual(order, ["chat-before"], "the video waits for the chat in flight, and the later chat for the video");
  first.state.release!();
  await settle();
  assert.deepEqual(order, ["chat-before", "video"]);
  assert.equal(queue.held, true, "held from the grant");
  alone!.release();
  await settle();
  assert.deepEqual(order, ["chat-before", "video"], "the create's answer is in, but the job still holds the queue");
  alone!.unhold();
  await settle();
  assert.deepEqual(order, ["chat-before", "video", "chat-after"]);
});

test("an aborted acquireAlone lets what waited behind it go", async () => {
  const queue = new LlmQueue(4, 4);
  const order: string[] = [];
  const first = track(queue, 1, order, "a");
  const abort = new AbortController();
  const video = queue.acquireAlone(2, abort.signal).catch(() => "aborted");
  track(queue, 3, order, "b");
  await settle();
  assert.deepEqual(order, ["a"]);
  abort.abort();
  assert.equal(await video, "aborted");
  await settle();
  assert.deepEqual(order, ["a", "b"]);
  first.state.release!();
});
