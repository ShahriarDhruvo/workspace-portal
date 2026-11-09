import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatDuration, formatRelative, initials, stopReasonText, summarizeWorkspace } from "./format.ts";
import type { WorkspaceInfo } from "./gateway-types.ts";

test("formatBytes uses binary units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536 * 1024 * 1024), "1.5 GiB");
  assert.equal(formatBytes(412 * 1024 * 1024), "412 MiB");
  assert.equal(formatBytes(128 * 1024 ** 3), "128 GiB");
});

test("formatDuration is compact", () => {
  assert.equal(formatDuration(42), "42s");
  assert.equal(formatDuration(12 * 60 + 5), "12m");
  assert.equal(formatDuration(3 * 3600), "3h");
  assert.equal(formatDuration(3 * 3600 + 5 * 60), "3h 5m");
  assert.equal(formatDuration(2 * 86400 + 4 * 3600), "2d 4h");
});

test("formatRelative", () => {
  const now = 10_000_000_000;
  assert.equal(formatRelative(now - 10_000, now), "just now");
  assert.equal(formatRelative(now - 5 * 60_000, now), "5 min ago");
  assert.equal(formatRelative(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(formatRelative(now - 26 * 3_600_000, now), "yesterday");
  assert.equal(formatRelative(now - 40 * 86_400_000, now), null);
});

test("initials", () => {
  assert.equal(initials("ada", "Lovelace"), "AL");
  assert.equal(initials("Émile", "Zola"), "ÉZ");
});

test("stop reasons in plain words", () => {
  assert.equal(stopReasonText("idle", 30), "after 30 minutes without activity");
  assert.equal(stopReasonText("admin", 30), "by the administrator");
  assert.equal(stopReasonText("capacity", 30), "to free resources");
  assert.equal(stopReasonText("logout", 30), "because you signed out");
  assert.equal(stopReasonText("sessions_expired", 30), null, "never sent by the gateway");
  assert.equal(stopReasonText("something_new", 30), null);
  assert.equal(stopReasonText(null, 30), null);
});

const running: WorkspaceInfo = {
  userId: 2,
  status: "running",
  ready: true,
  startedAt: 1,
  lastActivityAt: 1,
  idleSeconds: 12 * 60,
  memoryBytes: 412 * 1024 * 1024,
  connections: { owner: 1, admin: 0 },
  llmInFlight: 0,
  busy: false,
  busyReason: null,
  stopPending: false,
  stopReason: null,
  lastError: null,
};

test("summarizeWorkspace", () => {
  assert.deepEqual(summarizeWorkspace(running, 30), { tone: "success", label: "Running", detail: "idle 12m · 412 MiB", title: null });
  assert.equal(summarizeWorkspace({ ...running, idleSeconds: 5 }, 30).detail, "active · 412 MiB");
  assert.equal(summarizeWorkspace({ ...running, ready: false }, 30).label, "Starting");
  assert.equal(summarizeWorkspace(null, 30).label, "Stopped");
  const idle = summarizeWorkspace({ ...running, status: "stopped", ready: false, stopReason: "idle" }, 30);
  assert.equal(idle.title, "Stopped after 30 minutes without activity");
  const working = summarizeWorkspace({ ...running, idleSeconds: 0, busy: true, busyReason: "task", stopPending: true }, 30);
  assert.deepEqual([working.label, working.detail], ["Working", "task running · stops when done · 412 MiB"]);
  assert.ok(working.title?.includes("stops once the work is done"));
  const failed = summarizeWorkspace({ ...running, status: "error", ready: false, lastError: "boom" }, 30);
  assert.deepEqual([failed.tone, failed.label, failed.title], ["danger", "Error", "boom"]);
});
