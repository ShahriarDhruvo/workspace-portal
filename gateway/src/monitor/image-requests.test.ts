import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyModelReader, generationPace, imageAskReader, type ImageAsk } from "./image-requests.ts";
import { LlmRequests } from "./llm-requests.ts";

const MODELS = ["Qwen-Image-2.1-Turbo", "Qwen-Image-2.1"];

function read(contentType: string, chunks: string[]): ImageAsk[] {
  const asks: ImageAsk[] = [];
  const observe = imageAskReader(contentType, MODELS, (ask) => asks.push(ask));
  for (const chunk of chunks) observe(Buffer.from(chunk));
  return asks;
}

test("the model and the number of images are read from a JSON or multipart body, also split across chunks", () => {
  assert.deepEqual(read("application/json", ['{"prompt":"a teapot","mod', 'el": "Qwen-Image-2.1-Turbo","n":3}']), [{ model: "Qwen-Image-2.1-Turbo", images: 3 }]);
  const form = '--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nQwen-Image-2.1\r\n--b\r\nContent-Disposition: form-data; name="n"\r\n\r\n2\r\n--b--';
  assert.deepEqual(read("multipart/form-data; boundary=b", [form.slice(0, 50), form.slice(50)]), [{ model: "Qwen-Image-2.1", images: 2 }]);
  const typed = '--b\r\nContent-Disposition: form-data; name="model"\r\nContent-Type: text/plain\r\n\r\nQwen-Image-2.1\r\n--b--';
  assert.deepEqual(read("multipart/form-data; boundary=b", [typed]), [{ model: "Qwen-Image-2.1", images: 1 }], "a field with its own headers");
  const file = '--b\r\nContent-Disposition: form-data; name="image"; filename="model"\r\n\r\nQwen-Image-2.1\r\n--b--';
  assert.deepEqual(read("multipart/form-data; boundary=b", [file]), [], "a file named model is no model field");
  assert.deepEqual(read("application/json", ['{"model":"gpt-image-1","n":50}']), [{ model: null, images: 10 }], "an unknown model is not shown; n is capped");
  assert.deepEqual(read("application/json", ['{"model":"Qwen-Image-2.1","n":1000}']), [{ model: "Qwen-Image-2.1", images: 10 }], "however large");
  assert.deepEqual(read("application/json", ['{"prompt":"x"}']), [], "nothing found: one image of no known model");
});

test("an image's pace leaves out its wait behind other images and behind the LLM's requests", () => {
  const clock = { now: 0 };
  const requests = new LlmRequests({ now: () => clock.now });
  const begin = (image: boolean, ask?: ImageAsk) => {
    const handle = requests.begin(1, null, image);
    handle.forwarded();
    if (ask) handle.imageAsk(ask);
    return handle;
  };
  const llm = begin(false);
  const turbo = { model: "Qwen-Image-2.1-Turbo", images: 1 };
  const first = begin(true, turbo);
  const second = begin(true, turbo);
  const pair = begin(true, { ...turbo, images: 2 });
  clock.now = 30_000;
  llm.finish("completed");
  clock.now = 50_000;
  first.finish("completed"); // 20 s after the LLM's answer
  clock.now = 68_000;
  second.finish("completed"); // 18 s after the first
  clock.now = 106_000;
  pair.finish("completed"); // two images in 38 s
  assert.deepEqual(requests.pace("image"), { model: "Qwen-Image-2.1-Turbo", seconds: 19 });
  assert.deepEqual(requests.lastGeneration(), { kind: "image", at: 106_000 });

  const failed = begin(true, turbo);
  clock.now = 110_000;
  failed.finish("failed");
  assert.deepEqual(requests.pace("image"), { model: "Qwen-Image-2.1-Turbo", seconds: 19 }, "a failed request has no pace");
  const cancelled = begin(true, turbo);
  clock.now = 113_000;
  cancelled.finish("aborted");
  assert.deepEqual(requests.pace("image"), { model: "Qwen-Image-2.1-Turbo", seconds: 19 }, "nor one whose client hung up");
});

test("an LLM request that ends without its first token or an answer held no LLM: an image's time does not start there", () => {
  const clock = { now: 0 };
  const requests = new LlmRequests({ now: () => clock.now });
  const image = requests.begin(1, null, true);
  image.forwarded();
  image.imageAsk({ model: "Qwen-Image-2.1-Turbo", images: 1 });
  for (const [at, end] of [[5_000, "aborted"], [8_000, "failed"]] as const) {
    clock.now = at;
    const chat = requests.begin(2);
    chat.forwarded();
    clock.now = at + 7_000;
    chat.finish(end); // waited for the swap back, then cancelled or refused
  }
  clock.now = 20_000;
  image.finish("completed");
  assert.deepEqual(requests.pace("image"), { model: "Qwen-Image-2.1-Turbo", seconds: 20 });
});

test("a media request's pace is per request; one beside the LLM does not wait for the LLM's", () => {
  const clock = { now: 0 };
  const requests = new LlmRequests({ now: () => clock.now, besideLlm: new Set(["qwen3-tts-1.7b"]) });
  const llm = requests.begin(1, null, false, null);
  llm.forwarded();
  const speech = requests.begin(1, null, false, { kind: "speech", model: null });
  speech.forwarded();
  speech.mediaModel("qwen3-tts-1.7b");
  const music = requests.begin(1, null, false, { kind: "music", model: "acestep-1.5-xl-turbo" });
  music.forwarded();
  clock.now = 4_000;
  speech.finish("completed");
  clock.now = 30_000;
  llm.finish("completed");
  clock.now = 33_000;
  music.finish("completed");
  assert.deepEqual(requests.pace("speech"), { model: "qwen3-tts-1.7b", seconds: 4 }, "from its forward, though the LLM had a request");
  assert.deepEqual(requests.pace("music"), { model: "acestep-1.5-xl-turbo", seconds: 3 }, "from the LLM's answer: it swaps with the LLM");
  assert.equal(requests.pace("image"), null);
  assert.deepEqual(requests.lastGeneration(), { kind: "music", at: 33_000 });
  const video = requests.begin(1, null, false, { kind: "video", model: "minimax-h3" });
  video.forwarded();
  clock.now = 34_000;
  video.finish("completed");
  assert.equal(requests.pace("video"), null, "a video's pace is its job's, not its create's");
  assert.deepEqual(requests.lastGeneration(), { kind: "music", at: 33_000 });
});

test("a pace is the median of the last five of its kind on the model of its kind that finished last", () => {
  assert.equal(generationPace([], "image"), null);
  const paces = [10, 90, 20, 21, 19, 18, 500].map((seconds) => ({ kind: "image" as const, model: "a", seconds }));
  assert.deepEqual(generationPace(paces, "image"), { model: "a", seconds: 20 });
  const more = [...paces, { kind: "image" as const, model: "b", seconds: 88 }, { kind: "image" as const, model: "b", seconds: 92 }, { kind: "speech" as const, model: "c", seconds: 3 }];
  assert.deepEqual(generationPace(more, "image"), { model: "b", seconds: 90 });
  assert.deepEqual(generationPace(more, "speech"), { model: "c", seconds: 3 });
});

test("a media request's model is read from its JSON or multipart body, when it is one of its kind's", () => {
  const read = (contentType: string, chunks: string[]) => {
    const models: string[] = [];
    const observe = bodyModelReader(contentType, ["qwen3-asr-1.7b", "sov-transcribe-1"], (model) => models.push(model));
    for (const chunk of chunks) observe(Buffer.from(chunk));
    return models;
  };
  const form = '--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nqwen3-asr-1.7b\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="a.flac"\r\n\r\n';
  assert.deepEqual(read("multipart/form-data; boundary=b", [form.slice(0, 40), form.slice(40)]), ["qwen3-asr-1.7b"]);
  assert.deepEqual(read("application/json", ['{"model": "sov-transcribe-1"}', '{"model": "qwen3-asr-1.7b"}']), ["sov-transcribe-1"], "heard once");
  assert.deepEqual(read("application/json", ['{"model":"whisper-1"}']), [], "not one of its kind's");
});
