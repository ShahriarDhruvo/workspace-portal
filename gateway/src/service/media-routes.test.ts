import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMediaRegistry } from "@portal/harnesses";
import { MediaRequestError, bodyModel, checkRouteModel, mediaRoute, modelPrefix } from "./media-routes.ts";

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
  const late = `--b\r\nContent-Disposition: form-data; name="first_frame"; filename="a.png"\r\n\r\n${"x".repeat(300_000)}\r\n--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nltx-2\r\n--b--`;
  assert.throws(() => bodyModel(REGISTRY, "video", "multipart/form-data; boundary=b", Buffer.from(late)), /"ltx-2" is neither/, "a model field after the keyframes is read too");
});

test("a request that names a model the registry has for other routes is refused; any other goes on", () => {
  const registry = parseMediaRegistry(
    JSON.stringify({
      image: { fast: { model: "Qwen-Image-2.1-Turbo" }, quality: { model: "Ming-Image-0.2-Design" } },
      imageEdit: { fast: { model: "Qwen-Image-2.1-Turbo" } },
      speech: { fast: { model: "qwen3-tts-1.7b", api: "qwen3-tts", voices: { ryan: "male, English" }, clone: "qwen3-tts-1.7b-clone" } },
      transcription: { fast: { model: "qwen3-asr-1.7b" } },
    }),
    "test",
  );
  const check = (pathname: string, named: string | null) => checkRouteModel(registry, pathname, mediaRoute(registry, "POST", pathname), named);
  const refused = (pathname: string, named: string, message: string) =>
    assert.throws(() => check(pathname, named), (error: unknown) => error instanceof MediaRequestError && error.status === 400 && error.message === message);
  refused("/v1/images/edits", "Ming-Image-0.2-Design", '"Ming-Image-0.2-Design" is not a model of /v1/images/edits. Its models are Qwen-Image-2.1-Turbo.');
  refused("/v1/images/generations", "qwen3-tts-1.7b", '"qwen3-tts-1.7b" is not a model of /v1/images/generations. Its models are Qwen-Image-2.1-Turbo, Ming-Image-0.2-Design.');
  refused("/v1/audio/speech", "qwen3-asr-1.7b", '"qwen3-asr-1.7b" is not a model of /v1/audio/speech. Its models are qwen3-tts-1.7b, qwen3-tts-1.7b-clone.');
  refused("/v1/chat/completions", "Qwen-Image-2.1-Turbo", '"Qwen-Image-2.1-Turbo" is not a model of /v1/chat/completions.');
  refused("/v1/messages/count_tokens", "qwen3-asr-1.7b", '"qwen3-asr-1.7b" is not a model of /v1/messages/count_tokens.');
  refused("/v1/audio/music", "qwen3-tts-1.7b", '"qwen3-tts-1.7b" is not a model of /v1/audio/music.'); // the registry has no music model
  for (const [pathname, named] of [
    ["/v1/images/edits", "Qwen-Image-2.1-Turbo"],
    ["/v1/images/generations", "Ming-Image-0.2-Design"],
    ["/v1/audio/speech", "qwen3-tts-1.7b-clone"],
    ["/v1/audio/transcriptions", "qwen3-asr-1.7b"],
    ["/v1/chat/completions", "qwen3.8-flash-next"],
    ["/v1/images/generations", "gpt-image-1"],
    ["/v1/audio/speech", null],
  ] as const) {
    assert.doesNotThrow(() => check(pathname, named), `${named} on ${pathname}`);
  }
  assert.throws(
    () => checkRouteModel({ image: registry.image! }, "/v1/images/edits", null, "Ming-Image-0.2-Design"),
    (error: unknown) => error instanceof MediaRequestError && error.message === '"Ming-Image-0.2-Design" is not a model of /v1/images/edits.',
    "a registry with no model that edits names none",
  );
});
