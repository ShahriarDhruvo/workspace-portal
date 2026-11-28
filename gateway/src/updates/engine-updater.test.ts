import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditLog, openDatabase, type EngineStatus } from "@portal/core";
import { ENGINE_REPOSITORY, engineDigest, FakeEngineHost, FakeEngineRegistry, FakeNotes, quiet } from "../../test/fakes.ts";
import { waitFor } from "../../test/harness.ts";
import { loadConfig } from "../config.ts";
import { EngineReleases } from "./engine-releases.ts";
import { CANCELLED, EngineUpdater, GATEWAY_STOPPED } from "./engine-updater.ts";
import { HostdError } from "../monitor/hostd.ts";
import { LlmQueue } from "../service/llm-queue.ts";

function setup(options: { host?: FakeEngineHost | null; drainMinutes?: number; busy?: () => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-updater-"));
  const config = loadConfig({ GATEWAY_CONTROL_SECRET: "c".repeat(32), PORTAL_DATA_DIR: dir, ENGINE_DRAIN_MINUTES: String(options.drainMinutes ?? 15) });
  const db = openDatabase(config.dbFile);
  const host = options.host === undefined ? new FakeEngineHost() : options.host;
  const registry = new FakeEngineRegistry();
  const clock = { now: 1_000_000 };
  const queue = new LlmQueue(3, 3);
  const updater = new EngineUpdater({
    config,
    host,
    releases: new EngineReleases({ registry, github: new FakeNotes(), notesRepo: "gufo-org/gufo", now: () => clock.now }),
    queue,
    db,
    log: quiet,
    now: () => clock.now,
    pollMs: 2,
    busy: options.busy,
  });
  const audits = () => db.select().from(auditLog).all().map((row) => ({ action: row.action, details: JSON.parse(row.details ?? "null") }));
  const done = () => waitFor(() => (updater.snapshot()?.finishedAt != null ? updater.snapshot() : null), "the engine job to finish");
  return { config, db, host: host!, registry, clock, queue, updater, audits, done, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("overview: the engine as hostd reports it, with the releases and their notes", async () => {
  const { updater, registry, cleanup } = setup();
  const overview = await updater.overview();
  assert.equal(overview.state, "ok");
  assert.equal(overview.engine?.version, "0.31.0");
  assert.equal(overview.drainMinutes, 15);
  assert.deepEqual(
    overview.releases?.releases.map((r) => [r.version, r.latest, r.notes?.breaking ?? null]),
    [
      ["0.34.0", true, true],
      ["0.33.0", false, false],
      ["0.32.0", false, null],
      ["0.31.0", false, null],
      ["0.30.0", false, null],
    ],
    "newest first, only release versions (no edge, sha-*)",
  );
  assert.equal(overview.releases?.releases[0]!.digest, engineDigest("0.34.0"));
  await updater.overview();
  assert.equal(registry.calls, 1, "cached");
  await updater.overview({ refresh: true });
  assert.equal(registry.calls, 2);
  cleanup();
});

test("overview: not set up, unreachable, or no engine", async () => {
  const off = setup({ host: null });
  assert.deepEqual((({ state, engine, releases }) => ({ state, engine, releases }))(await off.updater.overview()), { state: "off", engine: null, releases: null });
  await assert.rejects(off.updater.startUpdate({ version: "0.34.0", actorUserId: null }), { status: 503, code: "engine_unavailable" });
  off.cleanup();

  const down = setup();
  down.host.offline = true;
  const overview = await down.updater.overview();
  assert.equal(overview.state, "offline");
  assert.match(overview.error!, /ECONNREFUSED/);
  await assert.rejects(down.updater.startUpdate({ version: "0.34.0", actorUserId: null }), {
    code: "engine_unavailable",
    message: "The AI server's portal-hostd can't be reached: http://llm:9180: connect ECONNREFUSED",
  });
  down.cleanup();
});

test("an update downloads, drains the queue, restarts, then opens the queue again", async () => {
  const { updater, host, queue, audits, done, cleanup } = setup();
  const running = await queue.acquire(7);
  const job = await updater.startUpdate({ version: "0.34.0", actorUserId: null });
  assert.deepEqual([job.reuse, job.fromVersion, job.toVersion, job.image, job.cancellable], [false, "0.31.0", "0.34.0", `${ENGINE_REPOSITORY}@${engineDigest("0.34.0")}`, true]);
  await assert.rejects(updater.startUpdate({ version: "0.33.0", actorUserId: null }), { status: 409, code: "engine_job_running" });

  // Draining: new requests wait, the running one may finish.
  const draining = await waitFor(() => (updater.snapshot()?.phase === "draining" ? updater.snapshot() : null), "the drain");
  assert.equal(draining!.drain?.inFlight, 1);
  assert.equal(queue.paused, true);
  let granted = false;
  const waiting = queue.acquire(8).then((release) => {
    granted = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(granted, false);
  assert.deepEqual(host.calls, [`pull ${ENGINE_REPOSITORY}@${engineDigest("0.34.0")}`], "no restart while a request runs");
  running();

  const finished = await done();
  assert.equal(finished!.phase, "succeeded");
  assert.equal(finished!.toVersion, "0.34.0");
  assert.equal(host.version, "0.34.0");
  assert.equal(host.previous, "0.31.0");
  assert.equal(queue.paused, false);
  (await waiting)();
  assert.equal(granted, true, "the held request went through afterwards");
  assert.ok(finished!.log.some((line) => line === "pull done") && finished!.log.some((line) => line === "apply done"), "hostd's logs are part of the job's");
  assert.deepEqual(audits(), [{ action: "engine_updated", details: { from: "0.31.0", to: "0.34.0" } }]);
  cleanup();
});

test("a failed restart reports hostd's rollback; an image on the AI server is used without download or registry; refusals", async () => {
  const { updater, host, registry, queue, audits, done, cleanup } = setup();
  await assert.rejects(updater.startUpdate({ version: "0.31.0", actorUserId: null }), { status: 409, code: "already_current" });
  await assert.rejects(updater.startUpdate({ version: "latest", actorUserId: null }), { status: 400, code: "invalid_version" });
  await assert.rejects(updater.startUpdate({ version: "0.99.0", actorUserId: null }), { status: 404, code: "version_not_found" });

  host.failApply = "the engine reports 0.31.0, not 0.33.0";
  await updater.startUpdate({ version: "0.33.0", actorUserId: null });
  const failed = await done();
  assert.deepEqual([failed!.phase, failed!.rolledBack, failed!.error, failed!.step], ["failed", true, "the engine reports 0.31.0, not 0.33.0", "Failed; the previous version runs again"]);
  assert.equal(host.version, "0.31.0");
  assert.equal(queue.paused, false, "the queue opens again after a failure too");

  // 0.33.0 was downloaded by the failed try, and 0.31.0 ran before: both switch without the registry or a download.
  registry.failing = true;
  host.calls.length = 0;
  const again = await updater.startUpdate({ version: "0.33.0", actorUserId: null });
  assert.deepEqual([again.reuse, again.phase], [true, "draining"]);
  await done();
  assert.equal(host.version, "0.33.0");
  const back = await updater.startUpdate({ version: "0.31.0", actorUserId: null });
  const switched = await done();
  assert.deepEqual([back.reuse, switched!.phase, switched!.fromVersion, switched!.toVersion], [true, "succeeded", "0.33.0", "0.31.0"]);
  assert.ok(switched!.log.includes(`Using the image already on the AI server (${ENGINE_REPOSITORY}@${engineDigest("0.31.0")}).`));
  assert.equal(host.version, "0.31.0");
  assert.deepEqual(host.calls, [`apply ${ENGINE_REPOSITORY}@${engineDigest("0.33.0")} 0.33.0`, `apply ${ENGINE_REPOSITORY}@${engineDigest("0.31.0")} 0.31.0`], "no pull");
  assert.deepEqual(
    audits().map((a) => [a.action, a.details.from, a.details.to, a.details.rolledBack ?? null]),
    [
      ["engine_update_failed", "0.31.0", "0.33.0", true],
      ["engine_updated", "0.31.0", "0.33.0", null],
      ["engine_updated", "0.33.0", "0.31.0", null],
    ],
  );
  cleanup();
});

test("cancel during the download or the drain leaves the engine as it was; Restart now ends the drain", async () => {
  const { updater, host, queue, done, cleanup } = setup();
  host.jobPolls = 1_000_000; // the download never ends by itself
  await updater.startUpdate({ version: "0.34.0", actorUserId: null });
  await waitFor(() => host.calls.length === 1, "the download");
  assert.equal(await updater.cancel(), true);
  const cancelled = await done();
  assert.deepEqual([cancelled!.phase, cancelled!.error], ["cancelled", CANCELLED]);
  assert.ok(host.calls.includes("cancel"));
  assert.equal(host.version, "0.31.0");

  host.jobPolls = 1;
  const running = await queue.acquire(1);
  await updater.startUpdate({ version: "0.34.0", actorUserId: null });
  await waitFor(() => updater.snapshot()?.phase === "draining", "the drain");
  assert.equal(await updater.cancel(), true);
  await done();
  assert.equal(updater.snapshot()!.phase, "cancelled");
  assert.equal(queue.paused, false);
  assert.equal(host.version, "0.31.0");

  await updater.startUpdate({ version: "0.34.0", actorUserId: null });
  await waitFor(() => updater.snapshot()?.phase === "draining", "the drain");
  assert.equal(updater.restartNow(), true);
  const restarted = await done();
  assert.equal(restarted!.phase, "succeeded");
  assert.ok(restarted!.log.some((line) => line.startsWith("Restarting now on request; 1 request will be cut off")));
  assert.equal(await updater.cancel(), false, "nothing to cancel");
  assert.equal(updater.restartNow(), false);
  running();
  cleanup();
});

test("the drain waits for a video job, which holds no request slot", async () => {
  const { updater, host, queue, done, cleanup } = setup();
  const video = queue.hold();
  await updater.startUpdate({ version: "0.34.0", actorUserId: null });
  const draining = await waitFor(() => (updater.snapshot()?.phase === "draining" ? updater.snapshot() : null), "the drain");
  assert.deepEqual(draining!.drain && [draining.drain.inFlight, draining.drain.video], [0, true]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(host.calls, [`pull ${ENGINE_REPOSITORY}@${engineDigest("0.34.0")}`], "no restart while a video is made");
  video();
  assert.equal((await done())!.phase, "succeeded");
  assert.ok(updater.snapshot()!.log.some((line) => line.includes("0 requests and a video job still running")));
  cleanup();
});

test("the drain ends at ENGINE_DRAIN_MINUTES; shutdown records a running job as failed", async () => {
  const { updater, host, queue, clock, done, cleanup } = setup({ drainMinutes: 1 });
  const running = await queue.acquire(1);
  await updater.startUpdate({ version: "0.34.0", actorUserId: null });
  await waitFor(() => updater.snapshot()?.phase === "draining", "the drain");
  clock.now += 60_000;
  const finished = await done();
  assert.equal(finished!.phase, "succeeded");
  assert.ok(finished!.log.some((line) => line.startsWith("Still 1 request running after 1 minutes")));
  running();

  host.jobPolls = 1_000_000;
  await updater.startUpdate({ version: "0.33.0", actorUserId: null });
  updater.shutdown();
  assert.deepEqual([updater.snapshot()!.phase, updater.snapshot()!.error], ["failed", GATEWAY_STOPPED]);
  cleanup();
});

test("a job that shutdown recorded as failed stays so: its run, still under way, changes nothing more", async () => {
  // The gateway stops while the updater waits for hostd's answer: that the download has ended, or which version runs after the restart.
  const moments: Array<[string, (versionBefore: string, answer: EngineStatus) => boolean]> = [
    ["the download has ended", (_version, answer) => answer.job?.kind === "pull" && answer.job.phase === "succeeded"],
    ["the engine has restarted", (version) => version === "0.34.0"],
  ];
  for (const [when, reached] of moments) {
    const { updater, host, queue, audits, done, cleanup } = setup();
    const status = host.status.bind(host);
    host.status = async () => {
      const version = host.version;
      const answer = await status();
      if (reached(version, answer)) updater.shutdown();
      return answer;
    };
    await updater.startUpdate({ version: "0.34.0", actorUserId: null });
    const job = await done();
    assert.deepEqual([job.phase, job.error, job.drain, queue.paused], ["failed", GATEWAY_STOPPED, null, false], when);
    assert.deepEqual(audits(), [{ action: "engine_update_failed", details: { from: "0.31.0", to: "0.34.0", error: GATEWAY_STOPPED, rolledBack: false } }], when);
    cleanup();
  }
});

test("a job hostd lost in a restart of its own fails the update at once, and the queue opens again", async () => {
  const { updater, host, queue, done, cleanup } = setup();
  host.local.add("0.34.0");
  // hostd keeps its job in memory: after a restart it reports none.
  const status = host.status.bind(host);
  host.status = async () => ({ ...(await status()), job: null });
  await updater.startUpdate({ version: "0.34.0", actorUserId: null });
  const job = await done();
  assert.deepEqual([job.phase, job.error, queue.paused], ["failed", "portal-hostd restarted and lost its apply, so how it ended is not known.", false]);
  cleanup();
});

test("removing an engine image: not while a job runs, not the running one", async () => {
  const { updater, host, cleanup } = setup();
  host.local.add("0.30.0");
  await updater.removeImage(engineDigest("0.30.0"));
  assert.equal(host.local.has("0.30.0"), false);
  await assert.rejects(updater.removeImage("0.30.0"), { status: 400, code: "invalid_digest" });
  await assert.rejects(updater.removeImage(engineDigest("0.31.0")), { status: 409, code: "image_current", message: "The engine runs this image." });
  host.removeImage = () => Promise.reject(new HostdError(null, "unreachable", "http://llm:9180: connect ECONNREFUSED"));
  await assert.rejects(updater.removeImage(engineDigest("0.31.0")), { status: 502, code: "hostd_failed", message: "portal-hostd on the AI server: http://llm:9180: connect ECONNREFUSED" });
  cleanup();
});

test("nothing starts while an update of the other software on the AI server runs (one hostd job at a time)", async () => {
  const { updater, cleanup } = setup({ busy: () => true });
  await assert.rejects(updater.startUpdate({ version: "0.34.0", actorUserId: null }), { status: 409, code: "app_job_running" });
  await assert.rejects(updater.removeImage(engineDigest("0.30.0")), { status: 409, code: "app_job_running" });
  cleanup();
});
