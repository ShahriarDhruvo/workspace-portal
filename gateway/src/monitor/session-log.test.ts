import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, users, workspaceSessions, type PortalDb } from "@portal/core";
import type { FinishedLlmRequest } from "./llm-requests.ts";
import { quiet } from "../../test/fakes.ts";
import { SessionLog, type WorkspaceRunState } from "./session-log.ts";

function setup() {
  const db: PortalDb = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "session-log-")), "portal.sqlite"));
  const userId = db
    .insert(users)
    .values({ username: "ana", firstName: "Ana", lastName: "L", passwordHash: "x", createdAt: 1, updatedAt: 1 })
    .returning({ id: users.id })
    .get().id;
  const clock = { now: 10_000 };
  const log = new SessionLog({ db, log: quiet, now: () => clock.now });
  const state = (changes: Partial<WorkspaceRunState>): WorkspaceRunState => ({
    userId,
    status: "running",
    kind: "online",
    agent: "qwen",
    startedAt: 1_000,
    stoppedAt: null,
    ...changes,
  });
  const rows = () => db.select().from(workspaceSessions).all();
  return { db, userId, clock, log, state, rows };
}

function finished(id: number, userId: number, changes: Partial<FinishedLlmRequest> = {}): FinishedLlmRequest {
  return {
    id,
    userId,
    forwardedAt: 2_000,
    finishedAt: 5_000,
    durationMs: 3_000,
    queueMs: 0,
    ttftMs: 500,
    timings: { promptTokens: 900, cachedTokens: 100, promptMs: 1_500, generatedTokens: 60, generationMs: 1_000 },
    usage: { promptTokens: 1_000, completionTokens: 60 },
    ok: true,
    ...changes,
  };
}

test("a session opens at the start, stays open while it runs and closes at the stop", () => {
  const { log, state, rows } = setup();
  log.sync(state({ status: "starting" }));
  log.sync(state({ status: "running" }));
  log.sync(state({ status: "stopping" }));
  assert.equal(rows().length, 1, "one run, one session");
  assert.deepEqual([rows()[0]!.kind, rows()[0]!.startedAt, rows()[0]!.endedAt], ["online", 1_000, null]);
  const version = log.version;
  log.sync(state({ status: "stopped", stoppedAt: 4_000 }));
  assert.equal(rows()[0]!.endedAt, 4_000);
  assert.ok(log.version > version);
  log.sync(state({ status: "stopped", stoppedAt: 4_000 }));
  assert.equal(rows().length, 1, "saving the stopped state again changes nothing");

  log.sync(state({ startedAt: 6_000, kind: "private" }));
  assert.deepEqual(rows().map((row) => [row.kind, row.startedAt, row.endedAt]), [["online", 1_000, 4_000], ["private", 6_000, null]], "the next start is a new session");
});

test("a start that fails before it runs leaves no session; a run that fails later keeps its own", () => {
  const { log, state, rows, userId } = setup();
  log.sync(state({ status: "starting" }));
  log.sync(state({ status: "error", stoppedAt: 2_000 }));
  assert.equal(rows().length, 0);

  log.sync(state({ startedAt: 3_000 }));
  assert.equal(log.forwarded(1, userId), rows()[0]!.id);
  log.finished(finished(1, userId));
  log.sync(state({ startedAt: 3_000, status: "error", stoppedAt: 9_000 }));
  assert.deepEqual(rows().map((row) => [row.requests, row.endedAt]), [[1, 9_000]]);

  log.sync(state({ startedAt: 10_000, status: "starting" }));
  log.sync(state({ startedAt: 10_000, status: "running" }));
  log.sync(state({ startedAt: 10_000, status: "error", stoppedAt: 12_000 }));
  assert.deepEqual(rows().map((row) => [row.requests, row.endedAt]), [[1, 9_000], [0, 12_000]], "it ran, without a request");
});

test("a request counts in the session open when it reached the LLM server, even if that has closed since", () => {
  const { log, state, rows, userId } = setup();
  assert.equal(log.forwarded(1, userId), null, "no session: not counted");
  log.finished(finished(1, userId));
  log.sync(state({}));
  const id = log.forwarded(2, userId);
  log.forwarded(3, userId);
  log.sync(state({ status: "stopped", stoppedAt: 4_000 }));
  log.finished(finished(2, userId));
  log.finished(finished(3, userId, { ok: false, usage: null, durationMs: 1_000 }));
  log.finished(finished(2, userId));
  const row = rows().find((r) => r.id === id)!;
  assert.deepEqual(
    [row.requests, row.failed, row.promptTokens, row.outputTokens, row.cachedTokens, row.readTokens, row.readMs, row.writeTokens, row.writeMs, row.llmMs],
    [2, 1, 2_000, 120, 200, 1_800, 3_000, 120, 2_000, 4_000],
    "usage counts the tokens; without it the timings do; a request counts once",
  );
});

test("energy shares add up per session; reconcile closes what a gone workspace left open", () => {
  const { db, log, state, rows, userId } = setup();
  log.sync(state({}));
  const id = rows()[0]!.id;
  log.addEnergy([{ sessionId: id, joules: 300, ms: 2_000 }]);
  log.addEnergy([{ sessionId: id, joules: 150.5, ms: 1_000 }]);
  assert.deepEqual([rows()[0]!.energyJ, rows()[0]!.energyMs], [450.5, 3_000]);

  // A gateway restart: the new log picks the open session up; the workspace is gone, so it closes now.
  const clock = { now: 50_000 };
  const restarted = new SessionLog({ db, log: quiet, now: () => clock.now });
  restarted.reconcile([]);
  assert.equal(rows()[0]!.endedAt, 50_000);
  restarted.reconcile([state({ startedAt: 40_000 })]);
  assert.equal(rows().filter((row) => row.endedAt === null && row.userId === userId).length, 1, "a running workspace from before gets one");
});
