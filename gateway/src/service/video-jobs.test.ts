import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../lib/log.ts";
import { LlmQueue } from "./llm-queue.ts";
import { VideoJobs } from "./video-jobs.ts";

const log = createLogger(() => {});

function setup(state: (id: string) => Promise<string | null>) {
  let now = 1_000;
  const queue = new LlmQueue(4, 4);
  const asked: string[] = [];
  const status = async (id: string, model: string) => {
    asked.push(`${model}/${id}`);
    const answer = await state(id);
    return answer === null ? null : { status: answer, progress: answer === "completed" ? 100 : 40 };
  };
  const jobs = new VideoJobs({ status, log, now: () => now, pollMs: 60_000, lostAfterMs: 1_000, maxRunMs: 10_000, downloadGraceMs: 500, keepMs: 2_000 });
  return { queue, jobs, asked, create: (userId: number, model = "minimax-h3") => jobs.creating(userId, model, queue.hold()), advance: (ms: number) => (now += ms) };
}

test("a create holds the queue; a failed create lets go at once", () => {
  const { queue, create: creating, jobs } = setup(async () => "in_progress");
  const create = creating(1);
  assert.equal(queue.held, true);
  create.failed();
  create.failed();
  assert.equal(queue.held, false);
  assert.equal(jobs.running, 0);
});

test("a job holds the queue while it runs, and after it completes until its video is downloaded", async () => {
  const states = ["queued", "in_progress", "completed"];
  const { queue, jobs, create, asked } = setup(async () => states.shift() ?? "completed");
  create(7, "ltx-2.5-distilled").created("video_a");
  assert.equal(jobs.owns(7, "video_a"), true);
  assert.equal(jobs.owns(8, "video_a"), false, "another user's job is none of theirs");
  assert.equal(jobs.modelOf("video_a"), "ltx-2.5-distilled");
  assert.equal(jobs.modelOf("video_b"), null);
  assert.deepEqual(jobs.active(), [{ userId: 7, model: "ltx-2.5-distilled", startedAt: 1_000, progress: null }], "no progress before the server has said");
  await jobs.poll();
  assert.deepEqual(asked, ["ltx-2.5-distilled/video_a"], "asked of the model that makes it");
  await jobs.poll();
  assert.equal(queue.held, true, "running");
  assert.equal(jobs.active()[0]?.progress, 40);
  await jobs.poll();
  assert.equal(queue.held, true, "completed, not yet downloaded");
  jobs.done("video_a", "downloaded");
  assert.equal(queue.held, false);
  assert.equal(jobs.owns(7, "video_a"), true, "still its user's to download again");
});

test("a completed job nobody downloads lets go after the grace; a failed, cancelled or unknown one at once", async () => {
  const answers = new Map<string, string | null>([
    ["video_done", "completed"],
    ["video_failed", "failed"],
    ["video_gone", null],
  ]);
  const { queue, jobs, create, advance } = setup(async (id) => (answers.has(id) ? answers.get(id)! : "in_progress"));
  for (const id of answers.keys()) create(1).created(id);
  await jobs.poll();
  assert.equal(jobs.running, 1, "only the completed one still holds");
  advance(500);
  await jobs.poll();
  assert.equal(jobs.running, 0);
  assert.equal(queue.held, false);
});

test("a job the server stops answering about, or one that runs too long, lets go; ended jobs are forgotten after keepMs", async () => {
  let reachable = true;
  const { queue, jobs, create, advance } = setup(async () => {
    if (!reachable) throw new Error("connection refused");
    return "in_progress";
  });
  create(1).created("video_lost");
  reachable = false;
  await jobs.poll();
  assert.equal(queue.held, true, "one failed answer is not enough");
  advance(1_000);
  await jobs.poll();
  assert.equal(queue.held, false, "lost");

  reachable = true;
  create(1).created("video_long");
  advance(10_000);
  await jobs.poll();
  assert.equal(queue.held, false, "ran too long");
  advance(2_000);
  assert.equal(jobs.owns(1, "video_lost"), false, "forgotten");
});

test("a cancelled job lets go; the queue grants again what waited behind it", async () => {
  const { queue, jobs, create } = setup(async () => "in_progress");
  create(1).created("video_c");
  let granted = false;
  void queue.acquire(2).then(() => (granted = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false);
  jobs.done("video_c", "cancelled");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, true);
});

test("the pace is the median time from create to completed of the last five on the model that completed last", async () => {
  const { jobs, create, advance } = setup(async () => "completed");
  assert.equal(jobs.pace(), null);
  for (const [model, ms] of [["minimax-h3", 200_000], ["minimax-h3", 220_000], ["minimax-h3", 1_000_000], ["ltx-2.5-distilled", 40_000]] as const) {
    create(1, model).created(`video_${ms}`);
    advance(ms);
    await jobs.poll();
    jobs.done(`video_${ms}`, "downloaded");
  }
  assert.deepEqual(jobs.pace(), { model: "ltx-2.5-distilled", seconds: 40, at: 1_000 + 1_460_000 });
  create(1, "minimax-h3").created("video_last");
  advance(210_000);
  await jobs.poll();
  assert.deepEqual(jobs.pace()?.seconds, 215, "of minimax-h3's four: 200, 210, 220 and 1000 s");
});
