import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMediaRegistry } from "@portal/harnesses";
import { MediaRequestError, bodyModel, mediaRoute, modelPrefix } from "./media-routes.ts";

const REGISTRY = parseMediaRegistry(
  JSON.stringify({
    video: { fast: { model: "minimax-h3", sizes: ["512x512"], seconds: { min: 5, max: 14.375 }, request: { gufo: { preset: "fast" } } }, quality: { model: "minimax-h3", sizes: ["512x512"], seconds: { min: 5, max: 14.375 } } },
    music: { fast: { model: "acestep-1.5-xl-turbo" }, quality: { model: "acestep-1.5-xl-base" } },
    speech: { fast: { model: "qwen3-tts-1.7b", api: "qwen3-tts", voices: { ryan: "male, English" }, clone: "qwen3-tts-1.7b-clone" } },
  }),
  "test",
);

test("which kind a request is, and where its model comes from: the body, the job, or the server's own route", () => {
  assert.deepEqual(mediaRoute(REGISTRY, "POST", "/v1/audio/speech"), { kind: "speech", model: "root", video: null });
  assert.deepEqual(mediaRoute(REGISTRY, "POST", "/v1/audio/music"), { kind: "music", model: "body", video: null });
  assert.deepEqual(mediaRoute(REGISTRY, "POST", "/v1/videos"), { kind: "video", model: "body", video: { op: "create" } });
  const id = "video_0123456789abcdef01234567";
  assert.deepEqual(mediaRoute(REGISTRY, "GET", `/v1/videos/${id}`), { kind: "video", model: "job", video: { op: "status", id } });
  assert.deepEqual(mediaRoute(REGISTRY, "GET", `/v1/videos/${id}/content`)?.video, { op: "content", id });
  assert.deepEqual(mediaRoute(REGISTRY, "DELETE", `/v1/videos/${id}`)?.video, { op: "cancel", id });
  assert.equal(mediaRoute(REGISTRY, "POST", "/v1/audio/transcriptions"), null, "no transcription model: an ordinary request");
  assert.equal(mediaRoute(REGISTRY, "GET", "/v1/audio/music"), null);
  assert.equal(mediaRoute(REGISTRY, "GET", "/v1/videos/../slots"), null);
  assert.equal(mediaRoute(REGISTRY, "POST", "/audio/speech"), null);
  assert.equal(modelPrefix("/upstream/{model}", "minimax-h3"), "/upstream/minimax-h3");
  assert.equal(modelPrefix("", "minimax-h3"), "");
});

test("a music or video create names one of its kind's models, or gets the fast one", () => {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const named = bodyModel(REGISTRY, "music", "application/json", json({ model: "acestep-1.5-xl-base", prompt: "jazz" }));
  assert.equal(named.model, "acestep-1.5-xl-base");
  assert.equal(named.body.toString(), JSON.stringify({ model: "acestep-1.5-xl-base", prompt: "jazz" }), "sent as it came");
  const filled = bodyModel(REGISTRY, "music", "application/json; charset=utf-8", json({ prompt: "jazz" }));
  assert.deepEqual([filled.model, JSON.parse(filled.body.toString())], ["acestep-1.5-xl-turbo", { prompt: "jazz", model: "acestep-1.5-xl-turbo" }]);
  assert.equal(bodyModel(REGISTRY, "video", "application/json", json({ model: "minimax-h3" })).model, "minimax-h3");
  const form = '--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nminimax-h3\r\n--b\r\nContent-Disposition: form-data; name="prompt"\r\n\r\na fox\r\n--b--';
  assert.equal(bodyModel(REGISTRY, "video", "multipart/form-data; boundary=b", Buffer.from(form)).model, "minimax-h3");
  const refused = (kind: "music" | "video", body: string, status: number, message: RegExp) =>
    assert.throws(() => bodyModel(REGISTRY, kind, "application/json", Buffer.from(body)), (error: unknown) => error instanceof MediaRequestError && error.status === status && message.test(error.message));
  refused("music", JSON.stringify({ model: "qwen3.8-flash-next" }), 400, /^The music models are acestep-1\.5-xl-turbo and acestep-1\.5-xl-base: "qwen3\.8-flash-next" is neither\.$/);
  refused("music", "[1]", 400, /JSON object/);
  refused("music", "{", 400, /JSON or multipart/);
  assert.throws(() => bodyModel({}, "music", "application/json", Buffer.from("{}")), (error: unknown) => error instanceof MediaRequestError && error.status === 404);
});
