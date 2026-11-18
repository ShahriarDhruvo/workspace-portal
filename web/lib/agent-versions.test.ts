import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentActionError,
  agentPackageRows,
  currentImageMissing,
  formatStopwatch,
  jobElapsedMs,
  jobKind,
  jobOutcome,
  jobTitle,
  packageSummary,
  removeBlocker,
  updateBlocker,
  updateWork,
  agentStatus,
  agentJobStep,
} from "./agent-versions.ts";
import { ACTIVE_POLL_MS, IDLE_POLL_MS, isJobActive, mergeLoaded, pollDelay } from "./update-jobs.ts";
import type { AgentUpdateJob, AgentVersionInfo, AgentVersionsOverview } from "@portal/core/wire";

const qwen: AgentVersionInfo = {
  id: "qwen",
  name: "Qwen Code",
  packageName: "@qwen-code/qwen-code",
  current: "0.27.0",
  defaultVersion: "0.27.0",
  latest: "0.27.4",
  updateAvailable: true,
  releases: [
    { version: "0.27.4", publishedAt: 4, latest: true, notes: null },
    { version: "0.27.2", publishedAt: 2, latest: false, notes: { title: "v0.27.2", url: "https://github.com/QwenLM/qwen-code/releases/tag/v0.27.2", publishedAt: 2, body: "", breaking: true } },
    { version: "0.27.0", publishedAt: 1, latest: false, notes: null },
    { version: "0.26.0", publishedAt: null, latest: false, notes: null },
  ],
  installed: [
    { version: "0.27.0", image: "workspace-portal/workspace:qwen-0.27.0", sizeBytes: 1, createdAt: 1, current: true, inUse: 1 },
    { version: "0.26.0", image: "workspace-portal/workspace:qwen-0.26.0", sizeBytes: 1, createdAt: 1, current: false, inUse: 0 },
  ],
  running: [{ version: "0.27.0", count: 1 }],
};

function job(overrides: Partial<AgentUpdateJob> = {}): AgentUpdateJob {
  const phase = overrides.phase ?? "building";
  return {
    id: "job-1",
    agent: "dsh",
    fromVersion: "0.2.2-rc.1",
    toVersion: "0.2.2-rc.3",
    rebuild: false,
    reuse: false,
    actorUserId: 1,
    phase,
    step: null,
    log: [],
    startedAt: 1_000_000,
    finishedAt: phase === "building" || phase === "verifying" ? null : 1_060_000,
    error: null,
    ...overrides,
  };
}

test("polling is quick only while a job runs", () => {
  assert.equal(pollDelay(null), IDLE_POLL_MS);
  assert.equal(pollDelay(job({ phase: "building" })), ACTIVE_POLL_MS);
  assert.equal(pollDelay(job({ phase: "verifying" })), ACTIVE_POLL_MS);
  for (const phase of ["succeeded", "failed", "cancelled"] as const) {
    assert.equal(pollDelay(job({ phase })), IDLE_POLL_MS, phase);
    assert.equal(isJobActive(job({ phase })), false, phase);
  }
});

test("a poll without the gateway keeps the last versions on screen, with the error", () => {
  const versions = { agents: [qwen], job: null, registryError: null, checkedAt: 5 } satisfies AgentVersionsOverview;
  const down = { error: "unreachable", message: "The workspace service is not reachable." };
  assert.deepEqual(mergeLoaded({ data: versions, error: null }, { data: null, error: down }), { data: versions, error: down });
  const fresh = { ...versions, checkedAt: 6 };
  assert.deepEqual(mergeLoaded({ data: versions, error: down }, { data: fresh, error: null }), { data: fresh, error: null });
});

test("the current version's image can be missing", () => {
  assert.equal(currentImageMissing(qwen), false);
  assert.equal(currentImageMissing({ installed: qwen.installed.map((image) => ({ ...image, current: false })) }), true);
});

test("an image on the server is used as it is; any other version is built first", () => {
  assert.equal(updateWork(qwen, "0.26.0"), "switch");
  assert.equal(updateWork(qwen, "0.27.0"), "none");
  assert.equal(updateWork(qwen, "0.27.4"), "build");
  assert.equal(updateWork(qwen, "0.25.1"), "build");
  // The current version's image is missing: building it is the way back.
  assert.equal(updateWork({ current: "0.27.0", installed: qwen.installed.slice(1) }, "0.27.0"), "build");
});

test("Package images: every release the gateway lists, with its image and what its button does", () => {
  const rows = agentPackageRows(qwen);
  assert.deepEqual(
    rows.map((row) => [row.version, row.current, row.latest, row.notes?.breaking ?? null, row.image?.inUse ?? null, row.action]),
    [
      ["0.27.4", false, true, null, null, "build"],
      ["0.27.2", false, false, true, null, "build"],
      ["0.27.0", true, false, null, 1, "rebuild"],
      ["0.26.0", false, false, null, 0, "use"],
    ],
  );
  assert.equal(rows[0]!.publishedAt, 4);
  const missing = agentPackageRows({ ...qwen, installed: qwen.installed.slice(1) });
  assert.equal(missing.find((row) => row.current)?.action, "build", "the current version without its image: built again");
  assert.equal(packageSummary(rows, "this server"), "4 versions · 2 on this server");
  assert.equal(packageSummary(rows.slice(0, 1), "the LLM server"), "1 version · 0 on the LLM server");
});

test("one job at a time blocks every update; an offline gateway blocks everything", () => {
  assert.equal(updateBlocker({ job: null, offline: false }), null);
  assert.equal(updateBlocker({ job: job({ phase: "failed" }), offline: false }), null);
  assert.equal(updateBlocker({ job: job(), offline: false }), "An update is running. Wait for it to finish, or cancel it.");
  assert.equal(updateBlocker({ job: null, offline: true }), "The workspace service is unavailable right now.");
});

test("an image can't be removed while current, in use, or while its agent is being updated", () => {
  const idle = { job: null, offline: false };
  const [current, old] = qwen.installed as [AgentVersionInfo["installed"][number], AgentVersionInfo["installed"][number]];
  assert.equal(removeBlocker(idle, qwen, old), null);
  assert.equal(removeBlocker(idle, qwen, current), "New workspaces start from this image. Use another version first.");
  assert.equal(
    removeBlocker(idle, qwen, { ...old, inUse: 1 }),
    "1 running workspace uses it. It can be removed once that workspace has stopped.",
  );
  assert.equal(removeBlocker(idle, qwen, { ...old, inUse: 3 }), "3 running workspaces use it. It can be removed once they have stopped.");
  assert.equal(removeBlocker({ job: job({ agent: "dsh" }), offline: false }, qwen, old), null, "another agent's job");
  assert.equal(removeBlocker({ job: job({ agent: "qwen" }), offline: false }, qwen, old), "Wait until the update of Qwen Code has finished.");
  assert.equal(removeBlocker({ job: null, offline: true }, qwen, old), "The workspace service is unavailable right now.");
});

test("what a job does: a version change, or for the current version a rebuild, a build or a check", () => {
  assert.equal(jobKind(job()), "update");
  assert.equal(jobKind(job({ rebuild: true })), "update", "another version, from scratch");
  assert.equal(jobKind(job({ fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.1", rebuild: true })), "rebuild");
  // The same version without rebuild: the gateway built it because its image was missing, or used the image it has.
  assert.equal(jobKind(job({ fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.1" })), "build");
  assert.equal(jobKind(job({ fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.1", reuse: true })), "check");
  assert.equal(jobKind(job({ reuse: true })), "update", "a switch to an image on the server");
});

test("job titles by phase: a version change, a rebuild from scratch, a build of a missing image, a check", () => {
  const name = "DeepSeek Harness";
  assert.equal(jobTitle(job(), name), "Updating DeepSeek Harness 0.2.2-rc.1 → 0.2.2-rc.3");
  assert.equal(jobTitle(job({ phase: "succeeded" }), name), "DeepSeek Harness updated to 0.2.2-rc.3");
  assert.equal(jobTitle(job({ phase: "failed" }), name), "Update of DeepSeek Harness to 0.2.2-rc.3 failed");
  assert.equal(jobTitle(job({ phase: "cancelled" }), name), "Update of DeepSeek Harness to 0.2.2-rc.3 cancelled");
  // From scratch to another version: still a version change ("from scratch" is said beside it).
  assert.equal(jobTitle(job({ rebuild: true }), name), "Updating DeepSeek Harness 0.2.2-rc.1 → 0.2.2-rc.3");
  const rebuild = job({ fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.1", rebuild: true });
  assert.equal(jobTitle(rebuild, name), "Rebuilding DeepSeek Harness 0.2.2-rc.1");
  assert.equal(jobTitle({ ...rebuild, phase: "succeeded" }, name), "DeepSeek Harness 0.2.2-rc.1 rebuilt");
  assert.equal(jobTitle({ ...rebuild, phase: "failed" }, name), "Rebuild of DeepSeek Harness 0.2.2-rc.1 failed");
  // The current version without rebuild is no rebuild: its missing image built with the cache, or a check.
  const build = job({ fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.1" });
  assert.equal(jobTitle(build, name), "Building DeepSeek Harness 0.2.2-rc.1");
  assert.equal(jobTitle({ ...build, phase: "succeeded" }, name), "DeepSeek Harness 0.2.2-rc.1 built");
  assert.equal(jobTitle({ ...build, phase: "cancelled" }, name), "Build of DeepSeek Harness 0.2.2-rc.1 cancelled");
  const check = job({ ...build, phase: "verifying", reuse: true });
  assert.equal(jobTitle(check, name), "Checking DeepSeek Harness 0.2.2-rc.1");
  assert.equal(jobTitle({ ...check, phase: "succeeded" }, name), "DeepSeek Harness 0.2.2-rc.1 checked");
  assert.equal(jobTitle({ ...check, phase: "failed" }, name), "Check of DeepSeek Harness 0.2.2-rc.1 failed");
});

test("a finished job says what it means for new and running workspaces", () => {
  const dsh = { name: "DeepSeek Harness", running: [] };
  const succeeded = job({ phase: "succeeded" });
  assert.equal(jobOutcome(succeeded, dsh), "New DeepSeek Harness workspaces start with 0.2.2-rc.3.");
  assert.equal(
    jobOutcome(succeeded, { ...dsh, running: [{ version: "0.2.2-rc.3", count: 1 }, { version: "0.2.2-rc.1", count: 2 }] }),
    "New DeepSeek Harness workspaces start with 0.2.2-rc.3. 2 running workspaces keep their version until they restart.",
  );
  assert.equal(
    jobOutcome(succeeded, { ...dsh, running: [{ version: "0.2.2-rc.1", count: 1 }] }),
    "New DeepSeek Harness workspaces start with 0.2.2-rc.3. 1 running workspace keeps its version until it restarts.",
  );
  assert.equal(
    jobOutcome(job({ phase: "succeeded", rebuild: true }), { ...dsh, running: [{ version: "0.2.2-rc.1", count: 1 }] }),
    "New DeepSeek Harness workspaces start with 0.2.2-rc.3. 1 running workspace keeps its version until it restarts.",
    "another version from scratch",
  );
  const rebuilt = job({ phase: "succeeded", fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.1", rebuild: true });
  assert.equal(
    jobOutcome(rebuilt, { ...dsh, running: [{ version: "0.2.2-rc.1", count: 1 }] }),
    "New DeepSeek Harness workspaces start from the rebuilt image. 1 running workspace keeps the previous build until it restarts.",
  );
  // A missing image built again: there was no previous build to keep.
  const built = job({ phase: "succeeded", fromVersion: "0.2.2-rc.1", toVersion: "0.2.2-rc.1" });
  assert.equal(jobOutcome(built, dsh), "New DeepSeek Harness workspaces can start again, with 0.2.2-rc.1.");
  assert.equal(
    jobOutcome(built, { ...dsh, running: [{ version: "0.2.2-rc.1", count: 1 }] }),
    "New DeepSeek Harness workspaces can start again, with 0.2.2-rc.1.",
  );
  const checked = { ...built, reuse: true };
  assert.equal(
    jobOutcome(checked, { ...dsh, running: [{ version: "0.2.2-rc.1", count: 1 }] }),
    "Nothing changed: the image on this server reports 0.2.2-rc.1, and new workspaces still start with it.",
  );
  for (const phase of ["failed", "cancelled"] as const) {
    assert.equal(jobOutcome(job({ phase }), dsh), "Nothing changed: new workspaces still start with 0.2.2-rc.1.");
    assert.equal(jobOutcome({ ...rebuilt, phase }, dsh), "Nothing changed: new workspaces still start with 0.2.2-rc.1.");
    assert.equal(jobOutcome({ ...built, phase }, dsh), "Nothing changed: the 0.2.2-rc.1 image is still missing, so new workspaces can't start.");
  }
});

test("elapsed time as a stopwatch", () => {
  assert.equal(formatStopwatch(0), "0:00");
  assert.equal(formatStopwatch(7_400), "0:07");
  assert.equal(formatStopwatch(750_000), "12:30");
  assert.equal(formatStopwatch(3_723_000), "1:02:03");
  assert.equal(formatStopwatch(-5), "0:00");
  assert.equal(jobElapsedMs(job({ startedAt: 1_000 }), 61_000), 60_000, "running: until now");
  assert.equal(jobElapsedMs(job({ startedAt: 1_000, finishedAt: 31_000 }), 61_000), 30_000, "finished: until it ended");
});

test("gateway errors in words", () => {
  const notPublished = { error: "version_not_found", message: "Qwen Code 9.9.9 is not published (@qwen-code/qwen-code)." };
  assert.equal(agentActionError("update", notPublished), notPublished.message);
  assert.equal(
    agentActionError("update", { error: "registry_unreachable", message: "The npm registry is unreachable (fetch failed)." }),
    "The npm registry is unreachable (fetch failed). Nothing was started; try again in a minute.",
  );
  const running = { error: "update_running", message: "Qwen Code is being updated to 0.27.4. Wait for it to finish, or cancel it." };
  assert.equal(agentActionError("update", running), running.message);
  assert.match(agentActionError("update", { error: "timeout", message: "x" }), /may have started anyway/);
  assert.equal(
    agentActionError("remove", { error: "image_in_use", message: "workspace-portal/workspace:qwen-0.27.0 is in use…" }),
    "A workspace still uses this image. It can be removed once that workspace has stopped.",
  );
  assert.equal(agentActionError("remove", { error: "not_found", message: "There is no image …" }), "This image is no longer on the server.");
  assert.equal(agentActionError("cancel", { error: "unreachable", message: "The workspace service is not reachable." }), "The workspace service is not reachable.");
});

test("the agent's badge (updating, update available, up to date, ahead of latest, unknown) and job steps", () => {
  const agent = { id: "qwen" as const, current: "0.27.0", latest: "0.27.4", updateAvailable: true };
  assert.deepEqual(agentStatus(agent, null), { label: "Update available", variant: "warning", pending: false });
  assert.deepEqual(agentStatus({ ...agent, latest: "0.27.0", updateAvailable: false }, null), { label: "Up to date", variant: "success", pending: false });
  assert.deepEqual(agentStatus(agent, { agent: "qwen", finishedAt: null }), { label: "Updating…", variant: "info", pending: true });
  assert.equal(agentStatus(agent, { agent: "dsh", finishedAt: null }).label, "Update available");
  assert.deepEqual(agentStatus({ ...agent, latest: null, updateAvailable: false }, null), { label: "Latest unknown", variant: "secondary", pending: false });
  const ahead = { id: "dsh" as const, current: "0.2.2-rc.3", latest: "0.2.2-rc.1", updateAvailable: false };
  assert.deepEqual(agentStatus(ahead, null), { label: "Latest: 0.2.2-rc.1", variant: "secondary", pending: false });
  assert.deepEqual(agentJobStep(job({ phase: "building" })), { index: 1, count: 2, progress: 25 });
  assert.deepEqual(agentJobStep(job({ phase: "verifying" })), { index: 2, count: 2, progress: 75 });
  assert.deepEqual(agentJobStep(job({ phase: "verifying", reuse: true })), { index: 1, count: 1, progress: 50 });
  assert.equal(agentJobStep(job({ phase: "succeeded" })).progress, 100);
});
