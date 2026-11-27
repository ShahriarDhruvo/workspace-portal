import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditLog, openDatabase } from "@portal/core";
import { engineDigest, FakeAppHost, FakeAppNotes, FakeAppRegistry, quiet, VLLM_REPOSITORY, vllmTag } from "../../test/fakes.ts";
import { waitFor } from "../../test/harness.ts";
import { loadConfig } from "../config.ts";
import { AppReleases } from "./app-releases.ts";
import { AppUpdater, CANCELLED, GATEWAY_STOPPED, NO_APPS, OLD_HOSTD } from "./app-updater.ts";
import { HostdError } from "../monitor/hostd.ts";
import { LlmQueue } from "../service/llm-queue.ts";

function setup(options: { host?: FakeAppHost | null; drainMinutes?: number; busy?: () => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-updater-"));
  const config = loadConfig({ GATEWAY_CONTROL_SECRET: "c".repeat(32), PORTAL_DATA_DIR: dir, ENGINE_DRAIN_MINUTES: String(options.drainMinutes ?? 15) });
  const db = openDatabase(config.dbFile);
  const host = options.host === undefined ? new FakeAppHost() : options.host;
  const registry = new FakeAppRegistry();
  const github = new FakeAppNotes();
  const clock = { now: 1_000_000 };
  const queue = new LlmQueue(3, 3);
  const updater = new AppUpdater({
    config,
    host,
    releases: new AppReleases({ registry, github, now: () => clock.now }),
    queue,
    db,
    log: quiet,
    now: () => clock.now,
    pollMs: 2,
    busy: options.busy,
  });
  const audits = () => db.select().from(auditLog).all().map((row) => ({ action: row.action, details: JSON.parse(row.details ?? "null") }));
  const done = () => waitFor(() => (updater.snapshot()?.finishedAt != null ? updater.snapshot() : null), "the app job to finish");
  return { host: host!, registry, github, clock, queue, updater, audits, done, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("overview: each app as hostd reports it, with its releases from GitHub or its image registry", async () => {
  const { updater, registry, github, cleanup } = setup();
  const overview = await updater.overview();
  assert.equal(overview.state, "ok");
  assert.equal(overview.drainMinutes, 15);
  const [swap, vllm] = overview.apps;
  assert.equal(swap!.status.version, "276");
  assert.deepEqual(
    swap!.releases.releases.map((r) => [r.version, r.latest, r.notes?.title ?? null]),
    [
      ["277", true, "v277"],
      ["276", false, "v276"],
      ["275", false, "v275"],
      ["99", false, "v99"],
    ],
    "release numbers newest first; no release candidate (prerelease), no tag the pattern doesn't match",
  );
  assert.equal(swap!.releases.source, "mostlygeek/llama-swap");
  assert.deepEqual(
    vllm!.releases.releases.map((r) => [r.version, r.tag, r.latest, r.notes?.title ?? null]),
    [
      ["0.33.0", vllmTag("0.33.0"), true, "v0.33.0"],
      ["0.32.0", vllmTag("0.32.0"), false, "v0.32.0"],
      ["0.31.0", vllmTag("0.31.0"), false, null],
    ],
    "per version its newest tag (rocm10 over rocm7.9), with vLLM's notes",
  );
  assert.equal(vllm!.releases.source, VLLM_REPOSITORY);
  await updater.overview();
  assert.equal(registry.calls, 1, "cached");
  assert.deepEqual(github.calls.sort(), ["mostlygeek/llama-swap", "vllm-project/vllm"]);
  await updater.overview({ refresh: true });
  assert.equal(registry.calls, 2);
  cleanup();
});

test("overview: not set up, unreachable, or no apps on the AI server", async () => {
  const off = setup({ host: null });
  assert.deepEqual((({ state, apps }) => ({ state, apps }))(await off.updater.overview()), { state: "off", apps: [] });
  await assert.rejects(off.updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null }), { status: 503, code: "apps_unavailable" });
  off.cleanup();

  const down = setup();
  down.host.offline = true;
  const overview = await down.updater.overview();
  assert.equal(overview.state, "offline");
  assert.match(overview.error!, /ECONNREFUSED/);
  down.host.offline = false;
  down.host.noApps = true;
  assert.deepEqual((({ state, error }) => ({ state, error }))(await down.updater.overview()), { state: "no_apps", error: NO_APPS });
  down.host.status = () => Promise.reject(new HostdError(404, "not_found", "no such endpoint"));
  assert.deepEqual((({ state, error }) => ({ state, error }))(await down.updater.overview()), { state: "no_apps", error: OLD_HOSTD }, "a hostd without /v1/apps");
  down.cleanup();
});

test("an update installs, drains the queue, switches, then opens the queue again", async () => {
  const { updater, host, queue, audits, done, cleanup } = setup();
  const running = await queue.acquire(7);
  const job = await updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null });
  assert.deepEqual([job.app, job.appName, job.reuse, job.fromVersion, job.toVersion, job.phase, job.cancellable], ["llama-swap", "llama-swap", false, "276", "277", "installing", true]);
  await assert.rejects(updater.startUpdate({ app: "vllm", version: "0.33.0", actorUserId: null }), { status: 409, code: "app_job_running" });

  const draining = await waitFor(() => (updater.snapshot()?.phase === "draining" ? updater.snapshot() : null), "the drain");
  assert.equal(draining!.drain?.inFlight, 1);
  assert.equal(queue.paused, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(host.calls, ["install llama-swap 277"], "no switch while a request runs");
  running();

  const finished = await done();
  assert.equal(finished!.phase, "succeeded");
  assert.equal(host.apps.get("llama-swap")!.version, "277");
  assert.equal(queue.paused, false);
  assert.ok(finished!.log.includes("install done") && finished!.log.includes("apply done"), "hostd's logs are part of the job's");
  assert.deepEqual(audits(), [{ action: "app_updated", details: { app: "llama-swap", from: "276", to: "277" } }]);
  cleanup();
});

test("an image app installs the digest its tag has in the registry; a failed switch reports hostd's rollback", async () => {
  const { updater, host, queue, audits, done, cleanup } = setup();
  host.failApply = "sov-transcribe-1 did not become ready";
  await updater.startUpdate({ app: "vllm", version: "0.33.0", actorUserId: null });
  const failed = await done();
  assert.equal(host.calls[0], `install vllm 0.33.0 ${VLLM_REPOSITORY}@${engineDigest("0.33.0")} ${vllmTag("0.33.0")}`);
  assert.deepEqual([failed!.phase, failed!.rolledBack, failed!.error, failed!.step], ["failed", true, "sov-transcribe-1 did not become ready", "Failed; the previous version runs again"]);
  assert.equal(host.apps.get("vllm")!.version, "0.32.0");
  assert.equal(queue.paused, false, "the queue opens again after a failure too");

  // Installed by the failed try: switching to it again installs nothing.
  host.calls.length = 0;
  const again = await updater.startUpdate({ app: "vllm", version: "0.33.0", actorUserId: null });
  assert.deepEqual([again.reuse, again.phase], [true, "draining"]);
  await done();
  assert.deepEqual(host.calls, ["apply vllm 0.33.0"]);
  assert.deepEqual(
    audits().map((a) => [a.action, a.details.app, a.details.to, a.details.rolledBack ?? null]),
    [
      ["app_update_failed", "vllm", "0.33.0", true],
      ["app_updated", "vllm", "0.33.0", null],
    ],
  );
  cleanup();
});

test("refusals: the running version, an unknown app or version, a bad version, while Gufo updates", async () => {
  let engineBusy = false;
  const { updater, cleanup } = setup({ busy: () => engineBusy });
  await assert.rejects(updater.startUpdate({ app: "llama-swap", version: "276", actorUserId: null }), { status: 409, code: "already_current" });
  await assert.rejects(updater.startUpdate({ app: "ollama", version: "1", actorUserId: null }), { status: 404, code: "no_app" });
  await assert.rejects(updater.startUpdate({ app: "vllm", version: "0.99.0", actorUserId: null }), { status: 404, code: "version_not_found" });
  await assert.rejects(updater.startUpdate({ app: "llama-swap", version: "../x", actorUserId: null }), { status: 400, code: "invalid_version" });
  engineBusy = true;
  await assert.rejects(updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null }), { status: 409, code: "engine_job_running" });
  await assert.rejects(updater.removeVersion("llama-swap", "275"), { status: 409, code: "engine_job_running" });
  cleanup();
});

test("cancel during the install or the drain changes nothing; Restart now ends the drain", async () => {
  const { updater, host, queue, done, cleanup } = setup();
  host.jobPolls = 1_000_000; // the install never ends by itself
  await updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null });
  await waitFor(() => host.calls.length === 1, "the install");
  assert.equal(await updater.cancel(), true);
  const cancelled = await done();
  assert.deepEqual([cancelled!.phase, cancelled!.error], ["cancelled", CANCELLED]);
  assert.ok(host.calls.includes("cancel"));
  assert.equal(host.apps.get("llama-swap")!.version, "276");

  host.jobPolls = 1;
  const running = await queue.acquire(1);
  await updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null });
  await waitFor(() => updater.snapshot()?.phase === "draining", "the drain");
  assert.equal(await updater.cancel(), true);
  await done();
  assert.equal(updater.snapshot()!.phase, "cancelled");
  assert.equal(queue.paused, false);
  assert.equal(host.apps.get("llama-swap")!.version, "276");

  await updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null });
  await waitFor(() => updater.snapshot()?.phase === "draining", "the drain");
  assert.equal(updater.restartNow(), true);
  const restarted = await done();
  assert.equal(restarted!.phase, "succeeded");
  assert.ok(restarted!.log.some((line) => line.startsWith("Restarting now on request; 1 request will be cut off")));
  assert.equal(await updater.cancel(), false, "nothing to cancel");
  running();
  cleanup();
});

test("shutdown records a running job as failed; a failed install leaves the app as it was", async () => {
  const { updater, host, done, cleanup } = setup();
  host.failInstall = "install.sh exited with status 22";
  await updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null });
  const failed = await done();
  assert.deepEqual([failed!.phase, failed!.error], ["failed", "install.sh exited with status 22"]);
  assert.equal(host.apps.get("llama-swap")!.version, "276");

  host.failInstall = null;
  host.jobPolls = 1_000_000;
  await updater.startUpdate({ app: "llama-swap", version: "277", actorUserId: null });
  updater.shutdown();
  assert.deepEqual([updater.snapshot()!.phase, updater.snapshot()!.error], ["failed", GATEWAY_STOPPED]);
  cleanup();
});

test("removing a version: not the running one; hostd's refusals reach the admin", async () => {
  const { updater, host, cleanup } = setup();
  host.apps.get("llama-swap")!.installed.add("275");
  await updater.removeVersion("llama-swap", "275");
  assert.equal(host.apps.get("llama-swap")!.installed.has("275"), false);
  await assert.rejects(updater.removeVersion("llama-swap", "276"), { status: 409, code: "version_current" });
  await assert.rejects(updater.removeVersion("llama-swap", "275"), { status: 404, code: "not_found" });
  host.remove = () => Promise.reject(new HostdError(null, "unreachable", "http://llm:9180: connect ECONNREFUSED"));
  await assert.rejects(updater.removeVersion("llama-swap", "275"), { status: 502, code: "hostd_failed" });
  cleanup();
});
