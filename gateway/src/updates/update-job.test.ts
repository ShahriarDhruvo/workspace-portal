import { test } from "node:test";
import assert from "node:assert/strict";
import { auditLog, openDatabase, type AgentUpdateJob } from "@portal/core";
import { appendLog, finishJob } from "./update-job.ts";

const START: AgentUpdateJob = { id: "job-1", agent: "dsh", fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.3", rebuild: false, reuse: false, actorUserId: null, phase: "building", step: null, log: [], startedAt: 1_000, finishedAt: null, error: null };
const start = (): AgentUpdateJob => ({ ...START, log: [] });
const db = openDatabase(":memory:");
const audits = () => db.select().from(auditLog).all().map((row) => [row.action, row.actorUserId, row.details]);
const logged: unknown[][] = [];
const log = {
  info: (...line: unknown[]) => void logged.push(["info", ...line]),
  warn: (...line: unknown[]) => void logged.push(["warn", ...line]),
  error: (...line: unknown[]) => void logged.push(["error", ...line]),
};

test("a job logs and succeeds: audited, and logged with how long it took", () => {
  const job = start();
  job.step = "[dsh 1/3] RUN npm install";
  appendLog(job, ["#1 [dsh 1/3] RUN npm install", "#1 added 1 package"], 200);
  finishJob(db, log, "agent", job, 9_000, { phase: "succeeded", error: null, step: null }, { agent: "dsh" });
  assert.deepEqual(job, { ...START, phase: "succeeded", log: ["#1 [dsh 1/3] RUN npm install", "#1 added 1 package"], finishedAt: 9_000 });
  assert.deepEqual(audits(), [["agent_updated", null, '{"agent":"dsh"}']]);
  assert.deepEqual(logged, [["info", "agent updated", { agent: "dsh", seconds: 8 }]]);
});

test("a job fails or is cancelled with its reason, and then its log stays as it is", () => {
  for (const [phase, error, at, message] of [["failed", "exit code: 1", 2_000, "engine update failed"], ["cancelled", "Cancelled", 3_000, "engine update cancelled"]] as const) {
    const job = start();
    finishJob(db, log, "engine", job, at, { phase, error, step: "Failed" }, { error });
    assert.deepEqual([job.phase, job.error, job.finishedAt, job.step], [phase, error, at, "Failed"]);
    assert.deepEqual(logged.at(-1), ["warn", message, { error }]);
    assert.deepEqual(audits().at(-1), ["engine_update_failed", null, JSON.stringify({ error })]);
    appendLog(job, ["late"], 200);
    assert.deepEqual(job.log, [], "nothing changes once finished");
  }
});

test("the log keeps its last lines", () => {
  const job = start();
  for (let i = 0; i < 150; i++) appendLog(job, [`line ${i}`], 200);
  appendLog(job, Array.from({ length: 300 }, (_, i) => `burst ${i}`), 200);
  assert.equal(job.log.length, 200);
  assert.equal(job.log[0], "burst 100");
  assert.equal(job.log.at(-1), "burst 299");
});
