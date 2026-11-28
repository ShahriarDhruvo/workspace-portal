import { test } from "node:test";
import assert from "node:assert/strict";
import { cutOffText, drainLimitText, drainRunning } from "./update-jobs.ts";

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
