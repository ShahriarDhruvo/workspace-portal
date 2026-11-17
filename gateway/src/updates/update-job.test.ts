import { test } from "node:test";
import assert from "node:assert/strict";
import { CANCELLED, JOB_LOG_LINES, UpdateJob, type JobStart } from "./update-job.ts";

const START: JobStart = { id: "job-1", agent: "dsh", fromVersion: "0.2.2-rc.1", version: "0.2.2-rc.3", rebuild: false, reuse: false, actorUserId: 5, startedAt: 1_000 };

test("a job builds, verifies and succeeds", () => {
  const job = new UpdateJob(START);
  assert.deepEqual(job.snapshot(), { ...START, phase: "building", step: null, log: [], finishedAt: null, error: null });
  assert.equal(job.active, true);
  job.setStep("[dsh 1/3] RUN npm install");
  job.appendLog(["#1 [dsh 1/3] RUN npm install", "#1 added 1 package"]);
  job.verifying("dsh --version");
  assert.deepEqual([job.phase, job.snapshot().step], ["verifying", "dsh --version"]);
  job.succeed(9_000);
  assert.deepEqual(job.snapshot(), {
    ...START,
    phase: "succeeded",
    step: null,
    log: ["#1 [dsh 1/3] RUN npm install", "#1 added 1 package"],
    finishedAt: 9_000,
    error: null,
  });
  assert.equal(job.active, false);
});

test("a job fails or is cancelled from building or verifying, and then stays as it is", () => {
  const failed = new UpdateJob(START);
  failed.fail("exit code: 1", 2_000);
  assert.deepEqual([failed.phase, failed.snapshot().error, failed.snapshot().finishedAt], ["failed", "exit code: 1", 2_000]);
  const cancelled = new UpdateJob(START);
  cancelled.verifying("dsh --version");
  cancelled.cancel(3_000);
  assert.deepEqual([cancelled.phase, cancelled.snapshot().error], ["cancelled", CANCELLED]);
  for (const done of [failed, cancelled]) {
    assert.throws(() => done.succeed(4_000), /not verifying/);
    assert.throws(() => done.fail("again", 4_000), /not building or verifying/);
    assert.throws(() => done.verifying("x"), /not building/);
    done.appendLog(["late"]);
    done.setStep("late");
    assert.equal(done.snapshot().log.includes("late"), false, "nothing changes once finished");
    assert.equal(done.snapshot().step, null);
  }
  assert.throws(() => new UpdateJob(START).succeed(1), /is building, not verifying/, "success needs the check");
});

test("the log keeps the last 200 lines, and snapshots are copies", () => {
  const job = new UpdateJob(START);
  for (let i = 0; i < 150; i++) job.appendLog([`line ${i}`]);
  job.appendLog(Array.from({ length: 300 }, (_, i) => `burst ${i}`));
  const { log } = job.snapshot();
  assert.equal(log.length, JOB_LOG_LINES);
  assert.equal(log[0], "burst 100");
  assert.equal(log.at(-1), "burst 299");
  log.push("changed by the caller");
  assert.equal(job.snapshot().log.length, JOB_LOG_LINES);
});
