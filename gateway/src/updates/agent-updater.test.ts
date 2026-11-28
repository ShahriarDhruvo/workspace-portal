import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditLog, openDatabase, users, type WorkspaceInfo } from "@portal/core";
import { AgentUpdater, GATEWAY_RESTARTED } from "./agent-updater.ts";
import { AgentVersions } from "./agent-versions.ts";
import { loadConfig } from "../config.ts";
import { stagingImage, workspaceImage } from "../docker/image-names.ts";
import { FakeImageBuilder, FakeRegistry, FakeRuntime, gate, quiet, recorder } from "../../test/fakes.ts";

function setup(options: { agents?: string; buildTimeoutMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-updater-"));
  // The versions installed below, whatever a fresh install builds.
  const config = loadConfig({ GATEWAY_CONTROL_SECRET: "c".repeat(32), PORTAL_DATA_DIR: dir, WORKSPACE_AGENTS: options.agents ?? "qwen,dsh", QWEN_CODE_VERSION: "0.27.0", DSH_VERSION: "0.2.2-rc.1" });
  const db = openDatabase(config.dbFile);
  const admin = db.insert(users).values({ username: "admin", firstName: "A", lastName: "B", passwordHash: "x", role: "admin", createdAt: 1, updatedAt: 1 }).returning().get();
  assert.equal(admin.id, ADMIN, "the acting admin");
  const { log, lines: logs } = recorder((level, msg, fields) => ({ level, msg, fields }));
  const versions = AgentVersions.fromConfig(config, log);
  const runtime = new FakeRuntime(dir);
  const builder = new FakeImageBuilder(runtime);
  builder.install("qwen", "0.27.0");
  builder.install("dsh", "0.2.2-rc.1");
  const registry = new FakeRegistry();
  const clock = { now: 1_000_000 };
  const state = { workspaces: [] as WorkspaceInfo[] };
  let ids = 0;
  const updater = new AgentUpdater({
    config,
    versions,
    builder,
    registry,
    workspaces: () => state.workspaces,
    db,
    log,
    now: () => clock.now,
    newId: () => `job-${++ids}`,
    buildTimeoutMs: options.buildTimeoutMs,
  });
  const audits = () => db.select().from(auditLog).all().map((row) => ({ action: row.action, actorUserId: row.actorUserId, details: JSON.parse(row.details ?? "null") }));
  const cleanup = (): void => {
    db.$client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { config, db, logs, versions, runtime, builder, registry, clock, state, updater, audits, cleanup };
}

const ADMIN = 1;
const update = { rebuild: false, actorUserId: ADMIN } as const;

test("an update builds a staging image, checks it, tags it and makes it current", async () => {
  const t = setup();
  try {
    const job = await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    assert.deepEqual(
      { ...job, log: [], step: null },
      { id: "job-1", agent: "qwen", fromVersion: "0.27.0", toVersion: "0.27.4", rebuild: false, reuse: false, actorUserId: ADMIN, phase: "building", step: null, log: [], startedAt: 1_000_000, finishedAt: null, error: null },
    );
    t.clock.now += 5_000;
    await t.updater.settled();
    const done = t.updater.job()!;
    assert.equal(done.phase, "succeeded");
    assert.deepEqual([done.finishedAt, done.error, done.step], [1_005_000, null, null]);
    assert.ok(done.log.includes("#2 added 14 packages in 7s"), "the build output");
    assert.equal(done.log.at(-1), "qwen --version: 0.27.4");
    done.log.push("changed by the caller");
    assert.equal(t.updater.job()!.log.at(-1), "qwen --version: 0.27.4", "the job is served as a copy");
    assert.deepEqual(t.builder.builds.map(({ outcome, ...spec }) => [spec, outcome]), [
      [{ kind: "qwen", version: "0.27.4", image: stagingImage("qwen", "0.27.4"), noCache: false }, "built"],
    ]);
    assert.deepEqual(t.builder.verified, [stagingImage("qwen", "0.27.4")], "the staging image is what gets checked");
    assert.ok(t.builder.images.has(workspaceImage("qwen", "0.27.4")));
    assert.equal(t.builder.images.has(stagingImage("qwen", "0.27.4")), false, "no staging tag left");
    assert.equal(t.versions.current("qwen"), "0.27.4");
    assert.equal(AgentVersions.fromConfig(t.config, quiet).current("qwen"), "0.27.4", "saved for the next gateway");
    assert.deepEqual(t.audits(), [{ action: "agent_updated", actorUserId: ADMIN, details: { agent: "qwen", from: "0.27.0", to: "0.27.4", rebuild: false } }]);
    assert.deepEqual(t.logs.at(-1), { level: "info", msg: "agent updated", fields: { agent: "qwen", from: "0.27.0", to: "0.27.4", rebuild: false, seconds: 5 } });
    assert.deepEqual(t.registry.calls, ["version @qwen-code/qwen-code@0.27.4"], "a build needs the version published");
    assert.equal(t.builder.sweeps, 1, "leftovers of interrupted jobs are cleared before the build");
  } finally {
    t.cleanup();
  }
});

test("a version whose image is on the server is used as it is: no registry, no build, but checked", async () => {
  const t = setup();
  try {
    const image = t.builder.install("qwen", "0.26.0");
    const installed = t.builder.images.get(image);
    t.registry.down = true;
    const job = await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.26.0" });
    assert.deepEqual([job.reuse, job.phase, job.step, job.log], [true, "verifying", "qwen --version", [`Using the image already on this server (${image}).`]], "straight to the check");
    await t.updater.settled();
    const done = t.updater.job()!;
    assert.deepEqual([done.phase, done.error, done.log.at(-1)], ["succeeded", null, "qwen --version: 0.26.0"]);
    assert.deepEqual([t.registry.calls, t.builder.builds, t.builder.sweeps], [[], [], 0], "going back works without the registry and builds nothing");
    assert.deepEqual(t.builder.verified, [image], "the image itself is checked");
    assert.equal(t.builder.images.get(image), installed, "and stays as it was");
    assert.equal(t.versions.current("qwen"), "0.26.0");
    assert.deepEqual(t.audits(), [{ action: "agent_updated", actorUserId: ADMIN, details: { agent: "qwen", from: "0.27.0", to: "0.26.0", rebuild: false } }]);

  } finally {
    t.cleanup();
  }
});

test("an image on the server that reports another version fails the job and stays; rebuild builds it anew", async () => {
  const t = setup();
  try {
    const image = t.builder.install("qwen", "0.26.0");
    t.builder.reportVersion = () => "0.25.9";
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.26.0" });
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["failed", "The image reports Qwen Code 0.25.9, not 0.26.0."]);
    assert.ok(t.builder.images.has(image), "a failed check removes nothing");
    assert.equal(t.versions.current("qwen"), "0.27.0");

    t.builder.reportVersion = null;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.26.0", rebuild: true });
    await t.updater.settled();
    assert.equal(t.updater.job()!.phase, "succeeded");
    assert.deepEqual(t.registry.calls, ["version @qwen-code/qwen-code@0.26.0"], "a build needs the version published");
    assert.deepEqual(t.builder.builds.map((b) => [b.image, b.noCache, b.outcome]), [[stagingImage("qwen", "0.26.0"), true, "built"]]);
    assert.match(t.builder.images.get(image)!.id, /^sha256:built-/, "the tag moved to the new build");
    assert.equal(t.versions.current("qwen"), "0.26.0");
  } finally {
    t.cleanup();
  }
});

test("a job that builds clears leftovers first, in the job: the request doesn't wait for it", async () => {
  const t = setup();
  try {
    const sweeping = gate();
    const sweep = t.builder.sweep.bind(t.builder);
    t.builder.sweep = async () => {
      await sweeping.promise;
      return sweep();
    };
    const starting = t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    // The fakes answer within microtasks: a request that waited for the sweep would still be pending.
    const answered = await Promise.race([starting, new Promise<null>((resolve) => setImmediate(() => resolve(null)))]);
    const meanwhile = {
      builds: t.builder.builds.length,
      refused: await t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" }).then(() => false, (error: { code?: string }) => error.code === "update_running"),
    };
    sweeping.open();
    await starting;
    await t.updater.settled();
    assert.equal(answered?.phase, "building", "the request answered while the sweep still ran");
    assert.deepEqual(meanwhile, { builds: 0, refused: true }, "the build waits for the sweep, and the job counts as running");
    assert.deepEqual([t.builder.sweeps, t.builder.builds.length, t.updater.job()!.phase], [1, 1, "succeeded"]);

    // Cancelled during the sweep: the build never runs.
    let cancelled = false;
    t.builder.sweep = async () => {
      cancelled = t.updater.cancel();
      return sweep();
    };
    await t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" });
    await t.updater.settled();
    assert.equal(cancelled, true, "the job exists and can be cancelled while it sweeps");
    assert.deepEqual([t.updater.job()!.phase, t.builder.builds.at(-1)!.outcome], ["cancelled", "aborted"]);
    assert.equal(t.versions.current("dsh"), "0.2.2-rc.1");
  } finally {
    t.cleanup();
  }
});

test("a rebuild records its outcome before it removes the build it replaced, and that removal is best effort", async () => {
  const t = setup();
  try {
    const image = t.builder.install("qwen", "0.26.0");
    const replaced = t.builder.images.get(image)!.id;
    const removeUntagged = t.builder.removeUntagged.bind(t.builder);
    let atRemoval: unknown = null;
    t.builder.removeUntagged = async (id) => {
      // What a gateway that stops now keeps: the outcome, the audit entry and the saved version.
      const kept = { phase: t.updater.job()!.phase, audits: t.audits().map((a) => a.action), saved: AgentVersions.fromConfig(t.config, quiet).current("qwen") };
      t.updater.shutdown();
      atRemoval = { ...kept, afterShutdown: t.updater.job()!.phase, tag: t.builder.images.get(image)!.id.startsWith("sha256:built-") };
      return removeUntagged(id);
    };
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.26.0", rebuild: true });
    await t.updater.settled();
    assert.deepEqual(atRemoval, { phase: "succeeded", audits: ["agent_updated"], saved: "0.26.0", afterShutdown: "succeeded", tag: true });
    assert.deepEqual(t.builder.removedIds, [replaced]);
    assert.equal(t.audits().length, 1, "a shutdown during the removal records nothing more");

    // A removal that fails is logged; the job has succeeded all the same.
    const rebuilt = t.builder.images.get(image)!.id;
    t.builder.removeUntagged = async () => Promise.reject(new Error("Docker is down"));
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.26.0", rebuild: true });
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["succeeded", null]);
    const { level, msg, fields } = t.logs.at(-1)!;
    assert.deepEqual([level, msg, fields?.image, (fields?.error as Error).message], ["warn", "could not remove the build a rebuild replaced", rebuilt, "Docker is down"]);
  } finally {
    t.cleanup();
  }
});

test("a failed job counts as running until its staging image is gone, and is audited before that", async () => {
  const t = setup();
  try {
    t.builder.reportVersion = () => "0.27.3";
    const discarding = gate();
    t.builder.discardGate = discarding.promise;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    while (t.updater.job()!.phase !== "failed") await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(t.audits().map((a) => a.action), ["agent_update_failed"], "recorded while `docker rmi` is still running");
    assert.ok(t.builder.images.has(stagingImage("qwen", "0.27.4")));
    // The admin retries at once: refused, or the late removal would take the new job's staging image.
    await assert.rejects(t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" }), {
      code: "update_running",
      message: "The last update is still cleaning up; try again in a moment.",
    });
    t.builder.discardGate = null;
    discarding.open();
    await t.updater.settled();
    assert.equal(t.builder.images.has(stagingImage("qwen", "0.27.4")), false);

    t.builder.reportVersion = null;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["succeeded", null]);
    assert.ok(t.builder.images.has(workspaceImage("qwen", "0.27.4")));
  } finally {
    t.cleanup();
  }
});

test("a gateway shutdown records the running job as failed at once (not as the admin's cancel)", async () => {
  const t = setup();
  try {
    t.builder.buildGate = gate().promise;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    t.updater.shutdown();
    // Synchronously: the process exits within a second, before the build has even noticed.
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["failed", GATEWAY_RESTARTED]);
    assert.deepEqual(t.audits(), [{ action: "agent_update_failed", actorUserId: ADMIN, details: { agent: "qwen", version: "0.27.4", error: GATEWAY_RESTARTED } }]);
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["failed", GATEWAY_RESTARTED], "recorded once");
    assert.deepEqual([t.updater.job()!.step, t.updater.job()!.log], [null, []], "what the build still reported doesn't show");
    assert.equal(t.audits().length, 1);
    assert.equal(t.builder.builds[0]!.outcome, "aborted");
    assert.equal(t.versions.current("qwen"), "0.27.0");
    t.updater.shutdown();
    assert.equal(t.audits().length, 1, "nothing running: nothing to record");
  } finally {
    t.cleanup();
  }
});

test("sweep logs what it removed and survives a Docker error", async () => {
  const t = setup();
  try {
    t.builder.images.set(stagingImage("dsh", "0.2.2-rc.3"), { id: "sha256:leftover", sizeBytes: 1, createdAt: 1 });
    await t.updater.sweep();
    assert.deepEqual(t.logs.at(-1), { level: "info", msg: "removed leftovers of earlier agent updates", fields: { containers: [], images: [stagingImage("dsh", "0.2.2-rc.3")] } });
    const count = t.logs.length;
    await t.updater.sweep();
    assert.equal(t.logs.length, count, "nothing removed, nothing logged");
    t.builder.sweep = async () => Promise.reject(new Error("Docker is down"));
    await t.updater.sweep();
    assert.equal(t.logs.at(-1)?.msg, "could not remove leftovers of earlier agent updates");
  } finally {
    t.cleanup();
  }
});

test("an exact version is checked against the registry; rebuild builds without the cache", async () => {
  const t = setup();
  try {
    await t.updater.startUpdate({ agent: "dsh", version: " 0.2.1 ", rebuild: true, actorUserId: null });
    await t.updater.settled();
    assert.deepEqual(t.registry.calls, ["version @deepseek-ai/dsh@0.2.1"]);
    assert.equal(t.builder.builds[0]!.noCache, true);
    assert.equal(t.versions.current("dsh"), "0.2.1", "rolling back is an update too");
    assert.deepEqual(t.audits()[0], { action: "agent_updated", actorUserId: null, details: { agent: "dsh", from: "0.2.2-rc.1", to: "0.2.1", rebuild: true } });
    // The current version can be built again (fresh packages); it stays current.
    await t.updater.startUpdate({ agent: "dsh", version: "0.2.1", rebuild: true, actorUserId: null });
    await t.updater.settled();
    assert.equal(t.updater.job()!.phase, "succeeded");
    assert.equal(t.updater.job()!.fromVersion, "0.2.1");
  } finally {
    t.cleanup();
  }
});

test("requests that can't be met are refused before anything starts", async () => {
  const t = setup({ agents: "qwen" });
  try {
    const refuse = (version: string, agent: "qwen" | "dsh" = "qwen") => t.updater.startUpdate({ ...update, agent, version });
    await assert.rejects(refuse("0.2.2", "dsh"), { status: 400, code: "agent_unavailable" });
    await assert.rejects(refuse("9.9.9"), { status: 404, code: "version_not_found" });
    await assert.rejects(refuse("9.9.9"), { message: "Qwen Code 9.9.9 is not published (@qwen-code/qwen-code)." });
    await assert.rejects(refuse("0.27.4; rm -rf /"), { status: 400, code: "invalid_version" });
    await assert.rejects(refuse("latest"), { code: "invalid_version", message: '"latest" is not a version (like 0.27.4).' }, "no release channels: the page sends the version it shows");
    t.registry.down = true;
    await assert.rejects(refuse("0.27.4"), { status: 502, code: "registry_unreachable" });
    assert.equal(t.builder.builds.length, 0);
    assert.equal(t.updater.job(), null);
    assert.deepEqual(t.audits(), [], "nothing happened, nothing to audit");
  } finally {
    t.cleanup();
  }
});

test("one job at a time, for all agents, including while a request is still being checked", async () => {
  const t = setup();
  try {
    const slow = gate();
    t.registry.gate = slow.promise;
    const first = t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    await assert.rejects(t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" }), { status: 409, code: "update_running" });
    const building = gate();
    t.builder.buildGate = building.promise;
    slow.open();
    t.registry.gate = null;
    await first;
    await assert.rejects(t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" }), {
      code: "update_running",
      message: "Qwen Code is being updated to 0.27.4. Wait for it to finish, or cancel it.",
    });
    building.open();
    await t.updater.settled();
    const next = await t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" });
    assert.equal(next.toVersion, "0.2.2-rc.3", "the next job may start once the first is done");
    await t.updater.settled();
  } finally {
    t.cleanup();
  }
});

test("cancelling while building or verifying leaves the current version and image as they were", async () => {
  const t = setup();
  try {
    assert.equal(t.updater.cancel(), false, "nothing to cancel");
    t.builder.buildGate = gate().promise;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    while (t.updater.job()!.step === null) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.updater.job()!.step, '[qwen 1/2] RUN npm install -g --no-fund --no-audit "@qwen-code/qwen-code@0.27.4"');
    assert.equal(t.updater.cancel(), true);
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["cancelled", "Cancelled"]);
    assert.equal(t.builder.builds[0]!.outcome, "aborted", "the build itself was abandoned");
    assert.equal(t.updater.cancel(), false, "already over");

    t.builder.buildGate = null;
    t.builder.verifyGate = gate().promise;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    while (t.updater.job()!.phase !== "verifying") await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.updater.job()!.step, "qwen --version");
    assert.equal(t.updater.cancel(), true);
    await t.updater.settled();
    assert.equal(t.updater.job()!.phase, "cancelled");
    assert.equal(t.builder.images.has(stagingImage("qwen", "0.27.4")), false, "the unchecked build is discarded");
    assert.equal(t.builder.images.has(workspaceImage("qwen", "0.27.4")), false, "and never tagged");
    assert.equal(t.versions.current("qwen"), "0.27.0");
    assert.deepEqual(t.audits().map((a) => [a.action, a.details]), [
      ["agent_update_failed", { agent: "qwen", version: "0.27.4", error: "Cancelled" }],
      ["agent_update_failed", { agent: "qwen", version: "0.27.4", error: "Cancelled" }],
    ]);
    assert.equal(t.logs.at(-1)?.msg, "agent update cancelled");
  } finally {
    t.cleanup();
  }
});

test("a failed build, a wrong version in the image and the time limit fail the job and change nothing", async () => {
  const t = setup({ buildTimeoutMs: 50 });
  try {
    t.builder.failNextBuild = 'process "/bin/sh -c npm install" did not complete successfully: exit code: 1';
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["failed", 'process "/bin/sh -c npm install" did not complete successfully: exit code: 1']);
    assert.ok(t.updater.job()!.log.some((line) => line.includes("npm error notarget")));

    // Rebuilding the current version, but the result reports another version: the current image stays.
    const currentImage = workspaceImage("qwen", "0.27.0");
    const before = t.builder.images.get(currentImage);
    t.builder.reportVersion = () => "0.26.9";
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.0", rebuild: true });
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["failed", "The new image reports Qwen Code 0.26.9, not 0.27.0."]);
    assert.equal(t.builder.images.get(currentImage), before, "the image new workspaces start from is untouched");
    assert.equal(t.builder.images.has(stagingImage("qwen", "0.27.0")), false);
    t.builder.reportVersion = null;

    t.builder.buildGate = gate().promise;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    await t.updater.settled();
    assert.deepEqual([t.updater.job()!.phase, t.updater.job()!.error], ["failed", "The update took longer than 0 minutes and was stopped."]);

    assert.equal(t.versions.current("qwen"), "0.27.0");
    assert.deepEqual(t.audits().map((a) => a.action), ["agent_update_failed", "agent_update_failed", "agent_update_failed"]);
    assert.ok(t.logs.filter((l) => l.msg === "agent update failed").every((l) => l.level === "warn"));
  } finally {
    t.cleanup();
  }
});

test("an admin deleted while the job ran is no reason to lose its audit entry", async () => {
  const t = setup();
  try {
    t.builder.buildGate = gate().promise;
    await t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" });
    t.db.$client.prepare("delete from users").run();
    t.updater.cancel();
    await t.updater.settled();
    assert.deepEqual(t.audits(), [{ action: "agent_update_failed", actorUserId: null, details: { agent: "dsh", version: "0.2.2-rc.3", error: "Cancelled" } }]);
  } finally {
    t.cleanup();
  }
});

test("if the choice can't be saved, the job fails and the version stays", async (context) => {
  if (process.getuid?.() === 0) return context.skip("root writes anyway");
  const t = setup();
  try {
    fs.mkdirSync(path.dirname(t.config.agentVersionsFile), { recursive: true, mode: 0o500 });
    await t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" });
    await t.updater.settled();
    assert.equal(t.updater.job()!.phase, "failed");
    assert.match(t.updater.job()!.error!, /EACCES/);
    assert.equal(t.versions.current("dsh"), "0.2.2-rc.1");
  } finally {
    fs.chmodSync(path.dirname(t.config.agentVersionsFile), 0o700);
    t.cleanup();
  }
});

test("image removal: never the current one, not while that agent updates, not while a container uses it", async () => {
  const t = setup();
  try {
    t.builder.install("qwen", "0.26.0");
    t.builder.install("qwen", "0.25.0");
    await assert.rejects(t.updater.removeImage("qwen", "latest"), { status: 400, code: "invalid_version" });
    await assert.rejects(t.updater.removeImage("qwen", "0.27.0"), { status: 409, code: "image_current" });
    await assert.rejects(t.updater.removeImage("qwen", "0.1.0"), { status: 404, code: "not_found" });
    // A container (any state) created from that image: Docker refuses to remove it.
    t.runtime.containers.get(t.runtime.addOrphan(98))!.image = workspaceImage("qwen", "0.26.0");
    await assert.rejects(t.updater.removeImage("qwen", "0.26.0"), { status: 409, code: "image_in_use" });

    t.builder.buildGate = gate().promise;
    await t.updater.startUpdate({ ...update, agent: "qwen", version: "0.27.4" });
    await assert.rejects(t.updater.removeImage("qwen", "0.25.0"), { status: 409, code: "update_running" });
    t.builder.install("dsh", "0.2.1");
    await t.updater.removeImage("dsh", "0.2.1");
    assert.equal(t.builder.images.has(workspaceImage("dsh", "0.2.1")), false, "another agent's images may go meanwhile");
    t.updater.cancel();
    await t.updater.settled();
    await t.updater.removeImage("qwen", "0.25.0");
    assert.equal(t.builder.images.has(workspaceImage("qwen", "0.25.0")), false);
    assert.deepEqual(t.logs.at(-1), { level: "info", msg: "agent image removed", fields: { agent: "qwen", version: "0.25.0", image: workspaceImage("qwen", "0.25.0") } });
  } finally {
    t.cleanup();
  }
});

test("the overview combines versions, registry releases, images and running workspaces; an outage only adds registryError", async () => {
  const t = setup({ agents: "dsh,qwen" });
  try {
    t.state.workspaces = [{ status: "running", agent: "qwen", agentVersion: "0.27.0" } as WorkspaceInfo];
    const overview = await t.updater.overview();
    assert.deepEqual(overview.agents.map((a) => a.id), ["dsh", "qwen"], "WORKSPACE_AGENTS order");
    const qwen = overview.agents[1]!;
    assert.deepEqual([qwen.current, qwen.defaultVersion, qwen.latest, qwen.updateAvailable], ["0.27.0", "0.27.0", "0.27.4", true]);
    assert.deepEqual(
      qwen.releases.map((r) => [r.version, r.latest]),
      [
        ["0.27.4", true],
        ["0.27.0", false],
        ["0.26.0", false],
      ],
      "the stable releases (no preview, nightly or experiment)",
    );
    assert.deepEqual(qwen.installed.map((i) => [i.version, i.current, i.inUse]), [["0.27.0", true, 1]]);
    assert.deepEqual(qwen.running, [{ version: "0.27.0", count: 1 }]);
    assert.deepEqual([overview.job, overview.registryError, overview.checkedAt], [null, null, 1_000_000]);

    t.registry.down = true;
    const down = await t.updater.overview({ refresh: true });
    assert.equal(down.registryError, "The npm registry is unreachable (fetch failed).");
    assert.equal(down.checkedAt, 1_000_000);
    assert.deepEqual(down.agents[1]!.releases.map((r) => r.version), ["0.27.4", "0.27.0", "0.26.0"], "the last answer, marked stale by the error");

    t.registry.down = false;
    await t.updater.startUpdate({ ...update, agent: "dsh", version: "0.2.2-rc.3" });
    await t.updater.settled();
    const after = await t.updater.overview();
    assert.equal(after.job?.phase, "succeeded", "the last finished job");
    assert.equal(after.agents[0]!.current, "0.2.2-rc.3");
    assert.equal(after.agents[0]!.updateAvailable, false, "ahead of latest (0.2.2-rc.1)");
  } finally {
    t.cleanup();
  }
});
