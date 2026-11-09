import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_CPU_CORES, busyReason, chooseEviction, EVICTION_MIN_IDLE_MS, idleMs, reapVerdict, type EvictionCandidate } from "./policy.ts";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const TIMEOUT = 30 * MIN;

test("busyReason: an agent task wins, then LLM traffic, then sustained CPU", () => {
  const quiet = { agentTask: false, llmBusy: false, cpuCores: 0.01 };
  assert.equal(busyReason(quiet), null);
  assert.equal(busyReason({ ...quiet, agentTask: true, llmBusy: true, cpuCores: 2 }), "task");
  assert.equal(busyReason({ ...quiet, llmBusy: true, cpuCores: 2 }), "llm");
  assert.equal(busyReason({ ...quiet, cpuCores: BUSY_CPU_CORES + 0.01 }), "cpu");
  assert.equal(busyReason({ ...quiet, cpuCores: BUSY_CPU_CORES }), null, "the threshold itself is not busy");
  assert.equal(busyReason({ agentTask: null, llmBusy: false, cpuCores: null }), null, "unknown is not busy");
});

test("idleMs is zero while working or when nothing was ever recorded", () => {
  assert.equal(idleMs({ lastActivityAt: NOW - 10 * MIN, busy: false }, NOW), 10 * MIN);
  assert.equal(idleMs({ lastActivityAt: NOW - 10 * MIN, busy: true }, NOW), 0);
  assert.equal(idleMs({ lastActivityAt: null, busy: false }, NOW), 0);
  assert.equal(idleMs({ lastActivityAt: NOW + MIN, busy: false }, NOW), 0, "clock skew never goes negative");
});

test("reapVerdict never stops a working workspace", () => {
  const base = { now: NOW, idleTimeoutMs: TIMEOUT, sessions: 1, busy: false };
  assert.equal(reapVerdict({ ...base, lastActivityAt: NOW - 5 * MIN }), "keep");
  assert.equal(reapVerdict({ ...base, lastActivityAt: NOW - TIMEOUT + 1 }), "keep");
  assert.equal(reapVerdict({ ...base, lastActivityAt: NOW - TIMEOUT }), "idle");
  assert.equal(reapVerdict({ ...base, lastActivityAt: NOW - 3 * TIMEOUT }), "idle");
  assert.equal(reapVerdict({ ...base, lastActivityAt: NOW - 3 * TIMEOUT, busy: true }), "keep", "a long task is not idleness");
  assert.equal(reapVerdict({ ...base, lastActivityAt: NOW, sessions: 0 }), "released");
  assert.equal(reapVerdict({ ...base, lastActivityAt: NOW, sessions: 0, busy: true }), "keep", "signed out mid-task: finish first");
});

test("chooseEviction picks the longest-idle ready workspace past the minimum", () => {
  const idleFor = (minutes: number): number => NOW - minutes * MIN;
  const candidates: EvictionCandidate[] = [
    { userId: 1, ready: true, busy: false, lastActivityAt: idleFor(6) },
    { userId: 2, ready: true, busy: false, lastActivityAt: idleFor(20) },
    { userId: 3, ready: true, busy: false, lastActivityAt: idleFor(2) },
  ];
  assert.equal(chooseEviction(candidates, 99, NOW), 2);
  assert.equal(chooseEviction(candidates, 2, NOW), 1, "never the requester");
});

test("chooseEviction skips working, unready and recently used workspaces", () => {
  const old = NOW - 60 * MIN;
  assert.equal(chooseEviction([{ userId: 1, ready: false, busy: false, lastActivityAt: old }], 9, NOW), null);
  assert.equal(chooseEviction([{ userId: 1, ready: true, busy: true, lastActivityAt: old }], 9, NOW), null);
  assert.equal(chooseEviction([{ userId: 1, ready: true, busy: false, lastActivityAt: NOW - EVICTION_MIN_IDLE_MS }], 9, NOW), null);
  assert.equal(chooseEviction([{ userId: 1, ready: true, busy: false, lastActivityAt: NOW - EVICTION_MIN_IDLE_MS - 1 }], 9, NOW), 1);
  assert.equal(chooseEviction([], 9, NOW), null);
});
