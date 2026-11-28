import { test } from "node:test";
import assert from "node:assert/strict";
import { cutOffText, drainLimitText, drainRunning, isCommitId, versionName } from "./update-jobs.ts";

test("a commit's full id is said by its first 7 characters; any other version as it is", () => {
  const commit = "d5615110e3ae7d27f270eafe5556d669b2069971";
  assert.equal(isCommitId(commit), true);
  assert.equal(versionName(commit), "d561511");
  for (const version of ["277", "0.31.0", "d561511", commit.slice(1), `${commit}0`, commit.toUpperCase()]) {
    assert.equal(isCommitId(version), false, version);
    assert.equal(versionName(version), version);
  }
});

test("a drain names the requests and the video job it waits for, and what its time limit and Restart now cut off", () => {
  assert.match(drainLimitText(15), /^Requests still running after 15 minutes are cut off/);
  assert.match(drainLimitText(1), /after 1 minute are cut off/);
  assert.equal(drainRunning({ inFlight: 1, video: false }), "1 request");
  assert.equal(drainRunning({ inFlight: 2, video: true }), "2 requests and a video job");
  assert.equal(drainRunning({ inFlight: 0, video: true }), "A video job");
  assert.equal(cutOffText({ inFlight: 2, video: false }), "2 running requests are cut off: their agents get an error and may retry.");
  assert.equal(cutOffText({ inFlight: 0, video: true }), "The video being made is lost.");
  assert.equal(cutOffText(null), "Requests still running are cut off: their agents get an error and may retry.");
});
