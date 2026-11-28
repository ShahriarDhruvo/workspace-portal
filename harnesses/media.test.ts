import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MEDIA_KINDS, besideLlmIds, imageModels, loadMediaRegistry, mediaModel, mediaModelIds, parseMediaRegistry } from "./media.ts";
import { AgentConfigError } from "./shared.ts";

const parse = (value: unknown) => parseMediaRegistry(JSON.stringify(value), "media.json");
const problems = (value: unknown): string[] => {
  try {
    parse(value);
  } catch (error) {
    assert.ok(error instanceof AgentConfigError);
    return error.message.split("\n  - ").slice(1);
  }
  assert.fail("expected an AgentConfigError");
};

test("the reference AI server's registry and the empty default parse", () => {
  const reference = loadMediaRegistry(new URL("../llm-server/media.json", import.meta.url).pathname);
  assert.deepEqual(Object.keys(reference), ["image", "imageEdit", "video", "music", "speech", "transcription"]);
  assert.equal(reference.video?.fast?.model, "minimax-h3");
  assert.deepEqual(reference.video?.fast?.request, { gufo: { preset: "fast" } });
  assert.equal(reference.speech?.fast?.voices?.ryan, "male, English");
  assert.deepEqual(imageModels(reference), ["Qwen-Image-2.1-Turbo", "Ming-Image-0.2-Design"], "the model that also edits is listed once");
  assert.equal(mediaModel(reference, "imageEdit", "quality")?.model, "Qwen-Image-2.1-Turbo", "one edit model: both tiers use it");
  assert.deepEqual([...besideLlmIds(reference)].sort(), ["qwen3-asr-1.7b", "qwen3-tts-1.7b", "qwen3-tts-1.7b-clone", "qwen3-tts-1.7b-design"]);
  assert.deepEqual(mediaModelIds(reference, "video"), ["minimax-h3"], "the same model under both tiers once");
  assert.deepEqual(mediaModelIds(reference, "speech"), ["qwen3-tts-1.7b", "qwen3-tts-1.7b-clone", "qwen3-tts-1.7b-design", "fish-drama-3"]);
  assert.deepEqual(loadMediaRegistry(new URL("../models/media.json", import.meta.url).pathname), {});
  assert.deepEqual(loadMediaRegistry("/nonexistent/media.json"), {}, "no file: no models");
});

test("every model the reference registry names is one the reference llama-swap serves (llm-server/llama-swap.yaml)", () => {
  const reference = loadMediaRegistry(new URL("../llm-server/media.json", import.meta.url).pathname);
  const yaml = fs.readFileSync(new URL("../llm-server/llama-swap.yaml", import.meta.url), "utf8");
  const models = /\nmodels:\n([\s\S]*?)\nrouting:\n/.exec(yaml)?.[1] ?? "";
  const served = [
    ...[...models.matchAll(/^  ([\w.-]+):$/gm)].map((match) => match[1]!),
    ...[...models.matchAll(/^    aliases: \[(.*)\]$/gm)].flatMap((match) => match[1]!.split(",").map((id) => id.trim())),
  ];
  const named = MEDIA_KINDS.flatMap((kind) => mediaModelIds(reference, kind));
  assert.deepEqual(named.filter((id) => !served.includes(id)), []);
});

test("defaults: a name is the id, the rest empty; a kind with one model gives it to both tiers", () => {
  const registry = parse({ music: { quality: { model: "acestep-1.5-xl-base" } } });
  assert.deepEqual(registry.music?.quality, { model: "acestep-1.5-xl-base", name: "acestep-1.5-xl-base", time: "", bestFor: "", besideLlm: false, request: {} });
  assert.equal(mediaModel(registry, "music", "fast")?.model, "acestep-1.5-xl-base");
  assert.equal(mediaModel(registry, "video", "fast"), null);
  assert.deepEqual(parseMediaRegistry("// nothing yet\n{}", "media.json"), {});
  assert.deepEqual(parseMediaRegistry("  ", "media.json"), {});
});

test("an image model may list the sizes it makes besides the default; no other kind but video has sizes", () => {
  const registry = parse({ image: { fast: { model: "Turbo", sizes: ["1344x768", "768x1344"] }, quality: { model: "Design" } }, imageEdit: { fast: { model: "Turbo", sizes: ["1344x768"] } } });
  assert.deepEqual(registry.image?.fast?.sizes, ["1344x768", "768x1344"]);
  assert.deepEqual(registry.imageEdit?.fast?.sizes, ["1344x768"]);
  assert.equal("sizes" in registry.image!.quality!, false, "the default size only");
  assert.deepEqual(problems({ image: { fast: { model: "Turbo", sizes: ["wide"] } }, imageEdit: { fast: { model: "Turbo", sizes: [] } }, music: { fast: { model: "m", sizes: ["512x512"] } } }), [
    "image.fast.sizes must be a list of distinct names",
    "imageEdit.fast.sizes must be a list of distinct names",
    "music.fast.sizes is not a field of a music model (fields: model, name, time, bestFor, besideLlm, request)",
  ]);
});

test("every problem is named at once", () => {
  assert.deepEqual(
    problems({
      images: {},
      music: { draft: { model: "x" }, fast: { model: "../x", time: "a\nb", besideLlm: "yes", request: { model: "y" } } },
      video: { fast: { model: "minimax-h3", sizes: ["512"], seconds: { min: 9, max: 5 }, voices: {} } },
      speech: { fast: { model: "fish-drama-3", api: "fish-speech", voices: { ryan: "male" } }, quality: { model: "qwen3-tts-1.7b", api: "qwen3-tts" } },
      transcription: { fast: {} },
      image: {},
    }),
    [
      '"images" is no kind of media: use image, imageEdit, video, music, speech, transcription',
      'music.draft: the tiers are "fast" and "quality"',
      "music.fast.model must be a model id such as Qwen-Image-2.1",
      "music.fast.besideLlm must be true or false",
      'music.fast.request may not set "model": the tool sets it',
      "music.fast.time must be one line of at most 120 characters",
      "video.fast.voices is not a field of a video model (fields: model, name, time, bestFor, besideLlm, request, sizes, seconds)",
      "video.fast.sizes must be a list of distinct names",
      'video.fast.sizes is required: the sizes it makes, such as ["512x512", "1344x768"]',
      'video.fast.seconds is required: { "min": 5, "max": 14 }, the clip lengths it makes',
      'speech.fast: voices, languages, clone and design belong to "qwen3-tts" models',
      'speech.quality.voices is required with "qwen3-tts": its built-in voices, the default first',
      "transcription.fast.model is required: the id the AI server serves it under",
      'image names no model: give it "fast", "quality" or both, or leave it out',
    ],
  );
  assert.throws(() => parseMediaRegistry("[]", "media.json"), /must contain a JSON object/);
  assert.throws(() => parseMediaRegistry("{", "media.json"), /is not valid JSON/);
});

test("deploy/models.sh accepts what the gateway does of media.json's shape", () => {
  const script = fs.readFileSync(new URL("../deploy/models.sh", import.meta.url), "utf8");
  assert.match(script, /media\.json/);
});
