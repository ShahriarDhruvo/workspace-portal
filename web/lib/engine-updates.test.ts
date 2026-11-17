import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineImage, EngineOverview, EngineRelease, EngineUpdateJob } from "@portal/core/wire";
import {
  compareEngineVersions,
  ENGINE_ACTIVE_POLL_MS,
  ENGINE_IDLE_POLL_MS,
  engineActionError,
  engineImageSchema,
  engineJobOutcome,
  engineJobStep,
  engineJobTitle,
  enginePollDelay,
  engineRemoveBlocker,
  engineStageLabel,
  engineStatusBadge,
  engineUpdateBlocker,
  engineUpdateTarget,
  engineVersionSchema,
  latestEngineRelease,
  enginePackageRows,
  mergeEngine,
} from "./engine-updates.ts";

const release = (version: string, latest = false): EngineRelease => ({ version, digest: null, latest, notes: null });

function overview(patch: Partial<EngineOverview> = {}, version: string | null = "0.31.0"): EngineOverview {
  return {
    state: "ok",
    error: null,
    engine: {
      unit: "gufo.service",
      quadlet: "/etc/containers/systemd/gufo.container",
      repository: "ghcr.io/example/engine",
      image: "ghcr.io/example/engine@sha256:aa",
      digest: null,
      version,
      revision: null,
      state: "active",
      subState: "running",
      ready: true,
      buildInfo: null,
      previous: null,
      images: [],
      job: null,
    },
    releases: { repository: "ghcr.io/example/engine", releases: [release("0.34.0", true), release("0.31.0"), release("0.30.0")], checkedAt: 1, error: null },
    job: null,
    drainMinutes: 15,
    ...patch,
  };
}

function job(patch: Partial<EngineUpdateJob> = {}): EngineUpdateJob {
  return {
    id: "j1",
    fromVersion: "0.31.0",
    toVersion: "0.34.0",
    image: null,
    reuse: false,
    stage: "pulling",
    step: "",
    log: [],
    startedAt: 0,
    finishedAt: null,
    error: null,
    rolledBack: false,
    drain: null,
    cancellable: true,
    actorUserId: 1,
    ...patch,
  };
}

const image = (patch: Partial<EngineImage> = {}): EngineImage => ({
  id: "i",
  digest: `sha256:${"a".repeat(64)}`,
  version: "0.30.0",
  revision: null,
  createdAt: null,
  sizeBytes: null,
  current: false,
  previous: false,
  ...patch,
});

test("versions compare numerically; the update target is latest when it is newer than what runs", () => {
  assert.ok(compareEngineVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareEngineVersions("1.2.3", "1.2.3"), 0);
  assert.equal(latestEngineRelease(overview())?.version, "0.34.0");
  assert.equal(engineUpdateTarget(overview()), "0.34.0");
  assert.equal(engineUpdateTarget(overview({}, "0.34.0")), null);
  assert.equal(engineUpdateTarget(overview({ releases: null })), null);
});

test("Package images: each release with its image on the LLM server, by version, else by digest", () => {
  const releases = [{ ...release("0.34.0", true), digest: "sha256:34" }, { ...release("0.31.0"), digest: "sha256:31" }, { ...release("0.30.0"), digest: "sha256:30" }];
  const images = [image({ version: "0.31.0", digest: "sha256:other", current: true }), image({ version: null, digest: "sha256:30" })];
  const rows = enginePackageRows(releases, { version: "0.31.0", images });
  assert.deepEqual(
    rows.map((row) => [row.version, row.latest, row.running, row.image?.digest ?? null]),
    [
      ["0.34.0", true, false, null],
      ["0.31.0", false, true, "sha256:other"],
      ["0.30.0", false, false, "sha256:30"],
    ],
  );
  const notes = { title: "v0.34.0", url: "https://github.com/x/y/releases/tag/v0.34.0", publishedAt: 9, body: "", breaking: true };
  assert.equal(enginePackageRows([{ ...release("0.34.0"), notes }], { version: null, images: [] })[0]!.publishedAt, 9, "the date is the GitHub release's");
});

test("the status badge: not set up, can't reach, updating, update available, up to date", () => {
  assert.equal(engineStatusBadge(overview({ state: "off", engine: null }), false).label, "Not set up");
  assert.equal(engineStatusBadge(overview({ state: "offline", engine: null }), false).variant, "destructive");
  assert.equal(engineStatusBadge(null, true).label, "Can't reach");
  assert.deepEqual(engineStatusBadge(overview({ job: job() }), false), { label: "Updating…", variant: "info", pending: true });
  assert.equal(engineStatusBadge(overview({ job: job({ stage: "restarting", rolledBack: true }) }), false).label, "Rolling back…");
  assert.equal(engineStatusBadge(overview(), false).label, "Update available");
  assert.equal(engineStatusBadge(overview({}, "0.34.0"), false).label, "Up to date");
  assert.equal(engineStatusBadge(overview({ releases: null }), false).label, "Latest unknown");
});

test("one job at a time; the running image can't be removed", () => {
  assert.equal(engineUpdateBlocker(overview(), false), null);
  assert.match(engineUpdateBlocker(overview({ job: job() }), false) ?? "", /running/);
  assert.match(engineUpdateBlocker(overview({ state: "offline" }), false) ?? "", /portal-hostd/);
  assert.match(engineUpdateBlocker(overview(), true) ?? "", /unavailable/);
  assert.equal(engineRemoveBlocker(overview(), false, image()), null);
  assert.match(engineRemoveBlocker(overview(), false, image({ current: true })) ?? "", /runs this image/);
  assert.match(engineRemoveBlocker(overview(), false, image({ digest: null })) ?? "", /no digest/);
});

test("job steps, titles and outcomes", () => {
  assert.deepEqual(engineJobStep(job()), { index: 1, count: 3, progress: 17 });
  assert.equal(engineStageLabel(job({ stage: "draining" })), "Waiting for running requests");
  assert.equal(engineStageLabel(job({ stage: "restarting", rolledBack: true })), "Putting 0.31.0 back");
  assert.deepEqual(engineJobStep(job({ reuse: true, stage: "restarting" })), { index: 2, count: 2, progress: 75 }, "no download");
  assert.equal(engineJobStep(job({ stage: "succeeded" })).progress, 100);
  assert.equal(engineJobTitle(job({ stage: "draining" })), "Updating the LLM engine 0.31.0 → 0.34.0");
  assert.equal(engineJobTitle(job({ stage: "succeeded" })), "LLM engine updated to 0.34.0");
  assert.equal(engineJobTitle(job({ fromVersion: "0.34.0", toVersion: "0.31.0", stage: "draining" })), "Switching the LLM engine 0.34.0 → 0.31.0");
  assert.equal(engineJobTitle(job({ fromVersion: "0.34.0", toVersion: "0.31.0", stage: "failed" })), "Switch of the LLM engine to 0.31.0 failed");
  assert.match(engineJobOutcome(job({ stage: "failed", rolledBack: true })), /0.34.0 didn't start properly, so 0.31.0 runs again/);
  assert.match(engineJobOutcome(job({ stage: "cancelled" })), /still runs 0.31.0/);
});

test("polling, merging and input", () => {
  assert.equal(enginePollDelay(job()), ENGINE_ACTIVE_POLL_MS);
  assert.equal(enginePollDelay(job({ finishedAt: 5, stage: "succeeded" })), ENGINE_IDLE_POLL_MS);
  assert.equal(enginePollDelay(null), ENGINE_IDLE_POLL_MS);
  const before = { engine: overview(), error: null };
  const failed = { engine: null, error: { error: "unreachable", message: "down" } };
  assert.deepEqual(mergeEngine(before, failed), { engine: before.engine, error: failed.error });
  assert.equal(engineVersionSchema.safeParse("0.34.0").success, true);
  for (const bad of ["latest", "v0.34.0", "0.34", "0.34.0-rc.1", ""]) assert.equal(engineVersionSchema.safeParse(bad).success, false, bad);
  assert.equal(engineImageSchema.safeParse({ digest: `sha256:${"0".repeat(64)}`, version: "0.30.0" }).success, true);
  assert.equal(engineImageSchema.safeParse({ digest: "sha256:xyz", version: null }).success, false);
});

test("errors in plain words", () => {
  assert.match(engineActionError("remove", { error: "not_found", message: "x" }), /no longer on the LLM server/);
  assert.match(engineActionError("update", { error: "timeout", message: "x" }), /may have started anyway/);
  assert.equal(engineActionError("update", { error: "version_not_found", message: "no digest" }), "no digest");
});
