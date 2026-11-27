import { test } from "node:test";
import assert from "node:assert/strict";
import { generationTileCopy, paceText } from "./generation-tile.ts";

const idle = { kind: null, making: 0, model: null, video: null, pace: null } as const;

test("the tile names the kind being made, or else made last, with its own unit", () => {
  assert.deepEqual(generationTileCopy(idle).label, "Generation");
  const images = generationTileCopy({ kind: "image", making: 2, model: "Qwen-Image-2.1-Turbo", video: null, pace: { model: "Qwen-Image-2.1-Turbo", seconds: 25.6 } });
  assert.deepEqual([images.label, images.figure, images.suffix, images.detail], ["Images", "2", "in progress", "26 s per image"]);
  assert.match(images.hint, /^Image requests being made now on Qwen-Image-2\.1-Turbo\. 26 s per image: the median/);
  const speech = generationTileCopy({ kind: "speech", making: 0, model: "qwen3-tts-1.7b", video: null, pace: { model: "qwen3-tts-1.7b", seconds: 4.2 } });
  assert.deepEqual([speech.label, speech.figure, speech.detail], ["Speech", "0", "4.2 s per request"]);
  assert.match(speech.hint, /^Nothing being made now; the last was a speech request\./);
  const music = generationTileCopy({ kind: "music", making: 1, model: "acestep-1.5-xl-base", video: null, pace: null });
  assert.equal(music.detail, "no track yet");
  assert.equal(generationTileCopy({ kind: "transcription", making: 0, model: null, video: null, pace: { model: null, seconds: 130 } }).detail, "2m 10s per file");
});

test("a running video shows its percent and its time so far", () => {
  const video = generationTileCopy({ kind: "video", making: 1, model: "minimax-h3", video: { progress: 41.6, elapsedSeconds: 95 }, pace: { model: "minimax-h3", seconds: 217.4 } });
  assert.deepEqual([video.label, video.figure, video.suffix, video.detail], ["Video", "42%", "done", "1m so far, about 3m 37s each"]);
  assert.match(video.hint, /from its start to its completion/);
  const early = generationTileCopy({ kind: "video", making: 1, model: "minimax-h3", video: { progress: null, elapsedSeconds: 5 }, pace: null });
  assert.deepEqual([early.figure, early.suffix, early.detail], ["1", "in progress", "5s so far"]);
});

test("paces read in seconds, then minutes and seconds, then hours", () => {
  assert.equal(paceText(9.44), "9.4 s");
  assert.equal(paceText(99.4), "99 s");
  assert.equal(paceText(217.4), "3m 37s");
  assert.equal(paceText(4460), "1h 14m");
});
