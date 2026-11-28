import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppRelease, AppsOverview, AppStatus, AppUpdateJob, AppVersion } from "@portal/core/wire";
import {
  appActionError,
  appJobOutcome,
  appJobStep,
  appJobTitle,
  appPackageRows,
  appPhaseLabel,
  appRemoveBlocker,
  appStatusBadge,
  appUpdateBlocker,
  appUpdateTarget,
  appVersionRefSchema,
  latestAppRelease,
  type AppEntry,
} from "./app-updates.ts";
import { engineUpdateBlocker } from "./engine-updates.ts";

const release = (version: string, latest = false): AppRelease => ({ version, tag: null, latest, notes: null });

const installed = (version: string, patch: Partial<AppVersion> = {}): AppVersion => ({
  version,
  image: null,
  createdAt: 0,
  sizeBytes: null,
  current: false,
  previous: false,
  ...patch,
});

function entry(patch: Partial<AppStatus> = {}, releases: AppRelease[] = [release("277", true), release("276"), release("99")]): AppEntry {
  return {
    status: {
      id: "llama-swap",
      name: "llama-swap",
      kind: "dir",
      unit: "llama-swap.service",
      model: null,
      releases: { github: "mostlygeek/llama-swap", tag: "^v([0-9]+)$" },
      version: "276",
      previous: null,
      state: "active",
      subState: "running",
      error: null,
      versions: [installed("276", { current: true }), installed("99")],
      ...patch,
    },
    releases: { source: "mostlygeek/llama-swap", releases, checkedAt: 1, error: null },
  };
}

function overview(patch: Partial<AppsOverview> = {}): AppsOverview {
  return { state: "ok", error: null, apps: [entry()], job: null, drainMinutes: 15, ...patch };
}

function job(patch: Partial<AppUpdateJob> = {}): AppUpdateJob {
  const phase = patch.phase ?? "installing";
  return {
    id: "j1",
    app: "llama-swap",
    appName: "llama-swap",
    fromVersion: "276",
    toVersion: "277",
    reuse: false,
    phase,
    step: "",
    log: [],
    startedAt: 0,
    finishedAt: phase === "succeeded" || phase === "failed" || phase === "cancelled" ? 60_000 : null,
    error: null,
    rolledBack: false,
    drain: null,
    cancellable: true,
    actorUserId: 1,
    ...patch,
  };
}

test("the update target is the latest release when it is newer than the version in use: release numbers as numbers", () => {
  assert.equal(latestAppRelease(entry())?.version, "277");
  assert.equal(appUpdateTarget(entry()), "277");
  assert.equal(appUpdateTarget(entry({ version: "277" })), null);
  assert.equal(appUpdateTarget(entry({ version: "1000" })), null, "1000 is newer than 277, not older");
  assert.equal(appUpdateTarget(entry({ version: null })), null);
  assert.equal(appUpdateTarget(entry({}, [])), null);
  const beta = entry({ version: "3.0.0-beta" }, [release("3.0.0", true), release("3.0.0-beta")]);
  assert.equal(appUpdateTarget(beta), "3.0.0", "a release after its prerelease");
});

test("Versions: each release with what is installed of it", () => {
  assert.deepEqual(
    appPackageRows(entry()).map((row) => [row.version, row.latest, row.running, row.image?.version ?? null]),
    [
      ["277", true, false, null],
      ["276", false, true, "276"],
      ["99", false, false, "99"],
    ],
  );
});

test("the status badge: updating this program, can't read, not running, update available, up to date", () => {
  assert.deepEqual(appStatusBadge(overview({ job: job() }), entry()), { label: "Updating…", variant: "info", pending: true });
  assert.equal(appStatusBadge(overview({ job: job({ phase: "restarting", rolledBack: true }) }), entry()).label, "Rolling back…");
  assert.equal(appStatusBadge(overview({ job: job({ app: "vllm" }) }), entry()).label, "Update available", "another program's job");
  assert.equal(appStatusBadge(overview(), entry()).label, "Update available");
  assert.equal(appStatusBadge(overview(), entry({ version: "277" })).label, "Up to date");
  assert.equal(appStatusBadge(overview(), entry({}, [])).label, "Latest unknown");
  assert.equal(appStatusBadge(overview(), entry({}, [release("276"), release("99")])).label, "Latest unknown", "the releases were never read: only the installed versions are listed");
  assert.equal(appStatusBadge(overview(), entry({ error: "cannot read /x" })).label, "Can't read");
  assert.equal(appStatusBadge(overview(), entry({ state: "inactive" })).label, "Not running", "llama-swap must run");
  const onDemand = entry({ id: "fish-speech", name: "Fish Speech", model: "fish-drama-3", state: "inactive", version: "277" });
  assert.equal(appStatusBadge(overview(), onDemand).label, "Up to date", "llama-swap starts it with its model");
  assert.equal(appStatusBadge(overview(), entry({ state: "failed" })).label, "Failed");
});

test("one job at a time on the AI server, for the programs and Gufo; the version in use can't be removed", () => {
  assert.equal(appUpdateBlocker(overview(), false, null), null);
  assert.match(appUpdateBlocker(overview({ job: job() }), false, null) ?? "", /AI server's software is running/);
  assert.match(appUpdateBlocker(overview(), false, { finishedAt: null }) ?? "", /Gufo update is running/);
  assert.equal(appUpdateBlocker(overview(), false, { finishedAt: 5 }), null, "Gufo's job has finished");
  assert.match(appUpdateBlocker(overview({ state: "offline" }), false, null) ?? "", /portal-hostd/);
  assert.match(appUpdateBlocker(overview(), true, null) ?? "", /unavailable/);
  assert.match(appRemoveBlocker(overview(), false, null, installed("276", { current: true })) ?? "", /in use/);
  assert.equal(appRemoveBlocker(overview(), false, null, installed("99")), null);
  assert.match(engineUpdateBlocker(null, false) ?? "", /unavailable/);
  assert.match(engineUpdateBlocker({ state: "ok", job: null } as never, false, job()) ?? "", /AI server's software is running/, "and Gufo waits for the programs");
});

test("job steps, titles and outcomes", () => {
  assert.deepEqual(appJobStep(job()), { index: 1, count: 3, progress: 17 });
  assert.deepEqual(appJobStep(job({ reuse: true, phase: "restarting" })), { index: 2, count: 2, progress: 75 }, "installed already");
  assert.equal(appPhaseLabel(job()), "Installing the new version");
  assert.equal(appPhaseLabel(job({ phase: "restarting" })), "Restarting llama-swap");
  assert.equal(appPhaseLabel(job({ phase: "restarting", rolledBack: true })), "Putting 276 back");
  assert.equal(appJobTitle(job({ phase: "draining" })), "Updating llama-swap 276 → 277");
  assert.equal(appJobTitle(job({ phase: "succeeded" })), "llama-swap updated to 277");
  assert.equal(appJobTitle(job({ fromVersion: "277", toVersion: "276", phase: "draining" })), "Switching llama-swap 277 → 276");
  assert.equal(appJobTitle(job({ fromVersion: "1000", toVersion: "999", phase: "failed" })), "Switch of llama-swap to 999 failed");
  assert.match(appJobOutcome(job({ phase: "failed", rolledBack: true })), /277 didn't start properly, so 276 is in use again/);
  assert.match(appJobOutcome(job({ phase: "cancelled" })), /llama-swap 276 is still in use/);
});

test("input and errors in plain words", () => {
  assert.equal(appVersionRefSchema.safeParse({ app: "llama-swap", version: "277" }).success, true);
  assert.equal(appVersionRefSchema.safeParse({ app: "fish-speech", version: "3.0.0-beta" }).success, true);
  for (const bad of [{ app: "llama-swap", version: "../277" }, { app: "llama-swap", version: "" }, { app: "Llama", version: "1" }, { app: "a/b", version: "1" }]) {
    assert.equal(appVersionRefSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.match(appActionError("remove", { error: "not_found", message: "x" }), /no longer on the AI server/);
  assert.match(appActionError("update", { error: "engine_job_running", message: "x" }), /Gufo update/);
  assert.match(appActionError("remove", { error: "version_current", message: "x" }), /in use/);
  assert.equal(appActionError("update", { error: "version_not_found", message: "no tag" }), "no tag");
});
