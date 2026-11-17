import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_UNKNOWN_GRACE_MS,
  agentCountsAsWorking,
  assessActivity,
  averageCores,
  BUSY_CPU_CORES,
  busyReason,
  chooseEviction,
  EVICTION_MIN_IDLE_MS,
  idleMs,
  pastBusyLimit,
  reapVerdict,
  type AgentState,
  type EvictionCandidate,
  type WorkspaceActivity,
} from "./policy.ts";

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

test("averageCores turns two cumulative samples into cores over the interval", () => {
  assert.equal(averageCores({ cpuSeconds: 10, at: 0 }, { cpuSeconds: 17.5, at: 15_000 }), 0.5);
  assert.equal(averageCores(null, { cpuSeconds: 10, at: 0 }), null, "first sample");
  assert.equal(averageCores({ cpuSeconds: 10, at: 5 }, { cpuSeconds: 11, at: 5 }), null, "no elapsed time");
  assert.equal(averageCores({ cpuSeconds: 10, at: 0 }, { cpuSeconds: 1, at: 15_000 }), null, "container restarted");
});

test("agentCountsAsWorking: the last answer, or while unknown, working for a grace period after it", () => {
  const answered = (working: boolean | null): AgentState => ({ working, answeredAt: NOW - MIN, unknown: false });
  assert.equal(agentCountsAsWorking(answered(true), NOW), true);
  assert.equal(agentCountsAsWorking(answered(false), NOW), false);
  assert.equal(agentCountsAsWorking(answered(null), NOW), false, "ready, but not asked yet");

  const unknownSince = (answeredAt: number | null, working: boolean | null = false): AgentState => ({ working, answeredAt, unknown: true });
  assert.equal(agentCountsAsWorking(unknownSince(NOW - MIN), NOW), true, "a slow answer may mean a busy agent, even after an idle answer");
  assert.equal(agentCountsAsWorking(unknownSince(NOW - AGENT_UNKNOWN_GRACE_MS + 1), NOW), true);
  assert.equal(agentCountsAsWorking(unknownSince(NOW - AGENT_UNKNOWN_GRACE_MS, true), NOW), false, "a broken qwen serve can't keep it up forever");
  assert.equal(agentCountsAsWorking(unknownSince(null), NOW), false, "never answered");
});

test("pastBusyLimit: strictly longer than the limit since a person did something; 0 is no limit", () => {
  assert.equal(pastBusyLimit(NOW - 60 * MIN, NOW, 60 * MIN), false);
  assert.equal(pastBusyLimit(NOW - 60 * MIN - 1, NOW, 60 * MIN), true);
  assert.equal(pastBusyLimit(NOW - 1_000 * MIN, NOW, 0), false);
  assert.equal(pastBusyLimit(null, NOW, 60 * MIN), false);
});

test("assessActivity: work counts as busy until the busy limit, then idle time runs from the person's last action", () => {
  const LIMIT = 60 * MIN;
  const looping: WorkspaceActivity = {
    agent: { working: true, answeredAt: NOW, unknown: false },
    llmBusy: true,
    cpuCores: 2,
    lastActivityAt: NOW, // its own LLM calls and steps keep this fresh
    lastUserActivityAt: NOW - 59 * MIN,
  };
  assert.deepEqual(assessActivity(looping, NOW, LIMIT), { busyReason: "task", busy: true, lastActivityAt: NOW });
  assert.deepEqual(assessActivity({ ...looping, agent: { ...looping.agent, working: false } }, NOW, LIMIT).busyReason, "llm");

  const later = NOW + 2 * MIN;
  assert.deepEqual(assessActivity({ ...looping, lastActivityAt: later }, later, LIMIT), { busyReason: null, busy: false, lastActivityAt: NOW - 59 * MIN });
  assert.equal(reapVerdict({ ...assessActivity({ ...looping, lastActivityAt: later }, later, LIMIT), now: later, idleTimeoutMs: TIMEOUT, sessions: 1 }), "idle");
  assert.equal(assessActivity({ ...looping, lastActivityAt: later }, later, 0).busy, true, "no limit");

  const quiet: WorkspaceActivity = { ...looping, agent: { working: false, answeredAt: NOW, unknown: false }, llmBusy: false, cpuCores: 0, lastActivityAt: NOW - 3 * MIN };
  assert.deepEqual(assessActivity(quiet, NOW, LIMIT), { busyReason: null, busy: false, lastActivityAt: NOW - 3 * MIN });
});
