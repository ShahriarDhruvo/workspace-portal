// The media tools' own logic (image/media-tools/lib.js, plain JavaScript for the workspace image): which model a call
// uses, how a speech request is put together, the text cut for Qwen3-TTS and the WAV around its PCM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMediaRegistry } from "../media.ts";

// A variable specifier: TypeScript leaves the JavaScript module untyped.
const LIB = new URL("./image/media-tools/lib.js", import.meta.url).href;
const lib: any = await import(LIB);
const reference = loadMediaRegistry(new URL("../../llm-server/media.json", import.meta.url).pathname);

test("a call uses its tier's model, the other tier's when there is only one, or the one it names", () => {
  assert.equal(lib.choose(reference.music, "music", { tier: "fast" }).entry.model, "acestep-1.5-xl-turbo");
  assert.equal(lib.choose(reference.music, "music", { tier: "quality" }).entry.model, "acestep-1.5-xl-base");
  const only = { quality: reference.music!.quality };
  const fallback = lib.choose(only, "music", { tier: "fast" });
  assert.equal(fallback.entry.tier, "quality");
  assert.match(fallback.note, /^This server has no fast music model: the quality one \(ACE-Step 1\.5 XL\) made it\.$/);
  assert.equal(lib.choose(reference.video, "video", { tier: "quality", model_override: "minimax-h3" }).entry.tier, "quality", "the override keeps its tier where it can");
  assert.throws(() => lib.choose(reference.music, "music", { tier: "best" }), /`tier` is required: fast or quality/);
  assert.throws(() => lib.choose(reference.music, "music", { tier: "fast", model_override: "suno" }), /model_override must be one of acestep-1\.5-xl-turbo, acestep-1\.5-xl-base/);
});

test("a tier's request fields go under the tool's own, objects merged", () => {
  assert.deepEqual(lib.withRequest({ model: "minimax-h3", gufo: { seed: 7 } }, reference.video!.fast!.request), { model: "minimax-h3", gufo: { preset: "fast", seed: 7 } });
  assert.deepEqual(lib.withRequest({ seed: 1 }, { seed: 2, steps: 8 }), { seed: 1, steps: 8 }, "the tool's own win");
});

test("a speech request picks Qwen3-TTS's model by how the voice is given, and refuses what a model cannot do", () => {
  const { fast, quality } = reference.speech!;
  const qwen = { ...fast, tier: "fast" };
  const fish = { ...quality, tier: "quality" };
  const ref = Buffer.from("RIFF");
  assert.deepEqual(lib.speechRequest(qwen, { voice: "aiden", instructions: "Warmly." }, null, qwen), { request: { model: "qwen3-tts-1.7b", voice: "aiden", instructions: "Warmly." }, voice: "aiden" });
  assert.equal(lib.speechRequest(qwen, {}, null, qwen).voice, "ryan", "the first voice is the default");
  assert.deepEqual(lib.speechRequest(qwen, { voice_description: "An old sea captain.", instructions: "Slowly." }, null, qwen).request, { model: "qwen3-tts-1.7b-design", instructions: "An old sea captain. Slowly." });
  assert.deepEqual(lib.speechRequest(qwen, { reference_text: "Hello there." }, ref, qwen).request, { model: "qwen3-tts-1.7b-clone", reference_audio: "data:audio/wav;base64,UklGRg==", reference_text: "Hello there." });
  assert.equal(lib.speechRequest(qwen, {}, ref, qwen).request.voice_clone_mode, "speaker_embedding_only", "no transcript of the recording");
  assert.deepEqual(lib.speechRequest(fish, {}, ref, qwen), { request: { model: "fish-drama-3", reference_audio: "data:audio/wav;base64,UklGRg==" }, voice: "cloned" });
  assert.throws(() => lib.speechRequest(fish, { voice: "ryan" }, null, qwen), /`voice` needs the fast tier/);
  assert.throws(() => lib.speechRequest(qwen, { voice: "nobody" }, null, qwen), /voices are ryan, aiden/);
  assert.throws(() => lib.speechRequest(qwen, { instructions: "Loud." }, ref, qwen), /don't apply to a cloned voice/);
  assert.throws(() => lib.speechRequest(qwen, { reference_text: "Hi." }, null, qwen), /reference_text goes with reference_audio/);
});

test("long text is spoken in pieces cut at sentence ends, none longer than the limit", () => {
  assert.deepEqual(lib.speechPieces("Short. Text!"), ["Short. Text!"]);
  const sentence = "This sentence has exactly sixty characters in it, roughly. ";
  const pieces: string[] = lib.speechPieces(sentence.repeat(50));
  assert.ok(pieces.length >= 3);
  for (const piece of pieces) {
    assert.ok(piece.length <= lib.SPEECH_PIECE_CHARS, `${piece.length} characters`);
    assert.match(piece, /roughly\.$/, "each ends a sentence");
  }
  assert.equal(pieces.join(" "), sentence.repeat(50).trim());
  const unbroken: string[] = lib.speechPieces(`${"word ".repeat(400)}end.`);
  assert.ok(unbroken.every((piece) => piece.length <= lib.SPEECH_PIECE_CHARS), "a sentence longer than a piece is cut at a space");
  assert.equal(unbroken.join(" "), `${"word ".repeat(400)}end.`.replace(/\s+/g, " "));
});

test("Qwen3-TTS's PCM becomes a 24 kHz mono 16-bit WAV", () => {
  const file: Buffer = lib.wav(Buffer.alloc(48_000));
  assert.equal(file.length, 44 + 48_000);
  assert.equal(file.toString("ascii", 0, 4), "RIFF");
  assert.equal(file.readUInt32LE(4), 36 + 48_000);
  assert.deepEqual([file.readUInt16LE(20), file.readUInt16LE(22), file.readUInt32LE(24), file.readUInt32LE(28), file.readUInt16LE(34)], [1, 1, 24_000, 48_000, 16]);
  assert.equal(file.readUInt32LE(40), 48_000);
});

test("list_media_models shows each tier's model, what it is for, and whether it is loaded", () => {
  const listing = lib.mediaListing(reference, ["qwen3.8-flash-next", "qwen3-tts-1.7b-design"]);
  assert.deepEqual(listing.models.image.quality, { model: "portal/Ming-Image-0.2-Design", name: "Ming-Image 0.2 Design", best_for: reference.image!.quality!.bestFor, time: reference.image!.quality!.time, beside_llm: false, loaded: false, sizes: reference.image!.quality!.sizes });
  assert.deepEqual([listing.models.imageEdit.tool, listing.models.imageEdit.fast.model], ["generate_image", "portal/Qwen-Image-2.1-Turbo"]);
  assert.equal(listing.models.speech.tool, "synthesize_speech");
  assert.equal(listing.models.speech.fast.loaded, true, "its design model is loaded");
  assert.equal(listing.models.speech.quality.clones_voices, true);
  assert.equal("subtitles" in listing.models.transcription.quality, false, "SOV writes no times under vLLM 0.32.0");
  assert.equal("loaded" in listing, false);
  assert.equal(lib.mediaListing(reference, null).loaded, "unknown");
});
