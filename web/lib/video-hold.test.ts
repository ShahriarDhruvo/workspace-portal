import { test } from "node:test";
import assert from "node:assert/strict";
import { timeLeftSeconds, videoHoldCopy } from "./video-hold.ts";

const hold = { elapsedSeconds: 720, progress: 40, own: false, waiting: 0 };

test("the time left follows from the share done so far, once there is enough to go by", () => {
  assert.equal(timeLeftSeconds(hold), 1080);
  assert.equal(timeLeftSeconds({ ...hold, progress: null }), null);
  assert.equal(timeLeftSeconds({ ...hold, progress: 2 }), null, "too early to say");
  assert.equal(timeLeftSeconds({ ...hold, progress: 100 }), null, "done: the download is left");
});

test("the notice says whose video it is and whether the person's own prompt waits", () => {
  assert.deepEqual(videoHoldCopy(hold), {
    title: "The AI server is making a video",
    body: "Prompts you send now wait until it is done, then run in the order they were sent.",
    progress: "12m so far, 40% done, about 18m left",
    urgent: false,
  });
  const waiting = videoHoldCopy({ ...hold, waiting: 2 });
  assert.equal(waiting.title, "Your request is waiting");
  assert.equal(waiting.urgent, true);
  assert.equal(videoHoldCopy({ ...hold, own: true, waiting: 1 }).title, "Your video is being made", "the owner's own requests wait by their choice");
  assert.equal(videoHoldCopy({ ...hold, progress: null }).progress, "12m so far");
});
