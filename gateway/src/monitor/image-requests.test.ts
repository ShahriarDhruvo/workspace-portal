import { test } from "node:test";
import assert from "node:assert/strict";
import { imageAskReader, imagePace, type ImageAsk } from "./image-requests.ts";
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
  assert.deepEqual(read("application/json", ['{"model":"gpt-image-1","n":50}']), [{ model: null, images: 10 }], "an unknown model is not shown; n is capped");
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
  llm.finish(true);
  clock.now = 50_000;
  first.finish(true); // 20 s after the LLM's answer
  clock.now = 68_000;
  second.finish(true); // 18 s after the first
  clock.now = 106_000;
  pair.finish(true); // two images in 38 s
  assert.deepEqual(requests.imagePace(), { model: "Qwen-Image-2.1-Turbo", secondsPerImage: 19 });

  const failed = begin(true, turbo);
  clock.now = 110_000;
  failed.finish(false);
  assert.deepEqual(requests.imagePace(), { model: "Qwen-Image-2.1-Turbo", secondsPerImage: 19 }, "a failed request has no pace");
});

test("imagePace is the median of the last five of the model that finished last", () => {
  assert.equal(imagePace([]), null);
  const paces = [10, 90, 20, 21, 19, 18, 500].map((secondsPerImage) => ({ model: "a", secondsPerImage }));
  assert.deepEqual(imagePace(paces), { model: "a", secondsPerImage: 20 });
  assert.deepEqual(imagePace([...paces, { model: "b", secondsPerImage: 88 }, { model: "b", secondsPerImage: 92 }]), { model: "b", secondsPerImage: 90 });
});
