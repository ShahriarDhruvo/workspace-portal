// What the media tools (index.js) work out without the network or the disk, apart so the tests can import it: an
// OpenCode plugin's entry module exports the plugin and nothing else.

const TIERS = ["fast", "quality"];
/** Qwen3-TTS's raw PCM: 16-bit little-endian, 24 kHz, mono. */
export const PCM = { rate: 24_000, channels: 1, bytesPerSample: 2 };
/**
 * Qwen3-TTS speaks up to 240 s a request, and its context holds the text and the speech together: longer text is
 * spoken in pieces of about this many characters, cut at the end of a sentence, with the same voice and seed.
 */
export const SPEECH_PIECE_CHARS = 1_200;

// --- Tiers -------------------------------------------------------------------------------------------------------

/** The kind's models, by tier. */
export function entries(tiers) {
  return TIERS.flatMap((tier) => (tiers?.[tier]?.model ? [{ ...tiers[tier], tier }] : []));
}

/** What the `tier` field says of the kind's two models. */
export function tierField(tiers, what) {
  const all = entries(tiers);
  const lines = all.map((entry) => `${entry.tier}: ${entry.name}${entry.bestFor ? `, for ${entry.bestFor}` : ""}${entry.time ? ` (${entry.time})` : ""}.`);
  const one = all.length === 1 ? ` This server has one ${what} model: both tiers use it.` : "";
  return { type: "string", enum: TIERS, description: `fast for drafts, tries and everyday work; quality for the final version or when the person asks for the best. ${lines.join(" ")}${one}` };
}

/** The `model_override` field: another of the kind's model ids, rarely needed. */
export function overrideField(tiers) {
  const ids = [...new Set(entries(tiers).map((entry) => entry.model))];
  return { type: "string", enum: ids, description: `Rarely needed: one of the ${ids.join(", ")} models to use instead of the tier's.` };
}

/**
 * The model a call uses: its tier's, or the other tier's when the server has only that one (said in `note`), or the
 * one `model_override` names.
 */
export function choose(tiers, kind, input) {
  if (!TIERS.includes(input.tier)) throw new Error("`tier` is required: fast or quality.");
  const all = entries(tiers);
  if (input.model_override) {
    const named = all.find((entry) => entry.model === input.model_override && entry.tier === input.tier) ?? all.find((entry) => entry.model === input.model_override);
    if (!named) throw new Error(`model_override must be one of ${all.map((entry) => entry.model).join(", ")}.`);
    return { entry: named, note: null };
  }
  const own = all.find((entry) => entry.tier === input.tier);
  if (own) return { entry: own, note: null };
  const [other] = all;
  return { entry: other, note: `This server has no ${input.tier} ${kind} model: the ${other.tier} one (${other.name}) made it.` };
}

/** `extra` laid under `body`: the tier's own request fields (a preset), objects merged one level deep. */
export function withRequest(body, extra) {
  const merged = { ...body };
  for (const [key, value] of Object.entries(extra ?? {})) {
    const own = merged[key];
    merged[key] = isObject(own) && isObject(value) ? { ...value, ...own } : (own ?? value);
  }
  return merged;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The tool's answer: compact JSON facts, never the file. */
export function answer(fields, note) {
  const facts = { status: "ok", ...fields, ...(note ? { note } : {}) };
  return { content: JSON.stringify(facts), metadata: facts };
}

// --- list_media_models -------------------------------------------------------------------------------------------

export const TOOL_OF = { image: "generate_image", video: "generate_video", music: "generate_music", speech: "synthesize_speech", transcription: "transcribe_audio" };

/** The registry as list_media_models shows it, with which models are loaded when that is known. */
export function mediaListing(kinds, loadedIds) {
  const loaded = loadedIds ? new Set(loadedIds) : null;
  const models = {};
  for (const [kind, tiers] of Object.entries(kinds ?? {})) {
    if (!(kind in TOOL_OF)) continue;
    models[kind] = { tool: TOOL_OF[kind] };
    for (const entry of entries(tiers)) {
      models[kind][entry.tier] = {
        model: kind === "image" ? `portal/${entry.model}` : entry.model,
        name: entry.name,
        ...(entry.bestFor ? { best_for: entry.bestFor } : {}),
        ...(entry.time ? { time: entry.time } : {}),
        beside_llm: entry.besideLlm === true,
        ...(loaded ? { loaded: [entry.model, entry.clone, entry.design].some((id) => id && loaded.has(id)) } : {}),
        ...(entry.sizes ? { sizes: entry.sizes } : {}),
        ...(entry.seconds ? { seconds: entry.seconds } : {}),
        ...(entry.voices ? { voices: entry.voices } : {}),
        ...(entry.languages ? { languages: entry.languages } : {}),
        ...(entry.clone || entry.api === "fish-speech" ? { clones_voices: true } : {}),
        ...(entry.design ? { designs_voices: true } : {}),
        ...(entry.subtitles ? { subtitles: true } : {}),
      };
    }
  }
  return { models, ...(loaded ? {} : { loaded: "unknown" }) };
}

// --- synthesize_speech -------------------------------------------------------------------------------------------

/**
 * The model and voice fields of a speech request, by how the voice is given: a recording to clone, a description, or
 * a built-in voice; and what the answer calls the voice.
 */
export function speechRequest(entry, input, reference, qwen) {
  const referenceFields = () => ({
    reference_audio: `data:audio/wav;base64,${reference.toString("base64")}`,
    ...(input.reference_text ? { reference_text: input.reference_text } : {}),
  });
  if (entry.api === "fish-speech") {
    for (const field of ["voice", "instructions", "voice_description"]) {
      if (input[field]) throw new Error(`\`${field}\` needs ${qwen ? `the ${qwen.tier} tier` : "a Qwen3-TTS model"}: the ${entry.tier} model (${entry.name}) speaks in its own voice or a reference_audio's.`);
    }
    return { request: { model: entry.model, ...(reference ? referenceFields() : {}) }, voice: reference ? "cloned" : "default" };
  }
  if (reference) {
    if (!entry.clone) throw new Error(`The ${entry.tier} speech model (${entry.name}) clones no voices.`);
    if (input.instructions || input.voice) throw new Error("`instructions` and `voice` don't apply to a cloned voice: leave them out.");
    return { request: { model: entry.clone, ...referenceFields(), ...(input.reference_text ? {} : { voice_clone_mode: "speaker_embedding_only" }) }, voice: "cloned" };
  }
  if (input.reference_text) throw new Error("reference_text goes with reference_audio.");
  if (input.voice_description) {
    if (!entry.design) throw new Error(`The ${entry.tier} speech model (${entry.name}) designs no voices.`);
    if (input.voice) throw new Error("Give voice or voice_description, not both.");
    const instructions = input.instructions ? `${input.voice_description.trim()} ${input.instructions.trim()}` : input.voice_description;
    return { request: { model: entry.design, instructions }, voice: "designed" };
  }
  const names = Object.keys(entry.voices ?? {});
  const voice = input.voice ?? names[0];
  if (!names.includes(voice)) throw new Error(`The ${entry.tier} speech model's voices are ${names.join(", ")}.`);
  return { request: { model: entry.model, voice, ...(input.instructions ? { instructions: input.instructions } : {}) }, voice };
}

/** The text in pieces of at most SPEECH_PIECE_CHARS, each ending a sentence where it can. */
export function speechPieces(text) {
  const sentences = text.trim().match(/[^.!?。！？\n]+(?:[.!?。！？]+["'”’)\]]*|\n+|$)\s*|[.!?。！？\n]+\s*/gu) ?? [text];
  const pieces = [];
  let piece = "";
  for (const sentence of sentences) {
    if (piece !== "" && piece.length + sentence.length > SPEECH_PIECE_CHARS) {
      pieces.push(piece.trim());
      piece = "";
    }
    // A sentence longer than a piece is cut at its last space before the limit.
    let rest = sentence;
    while (rest.length > SPEECH_PIECE_CHARS) {
      const cut = rest.lastIndexOf(" ", SPEECH_PIECE_CHARS);
      const at = cut > SPEECH_PIECE_CHARS / 2 ? cut : SPEECH_PIECE_CHARS;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    piece += rest;
  }
  if (piece.trim() !== "") pieces.push(piece.trim());
  return pieces.filter((part) => part !== "");
}

/** Raw PCM from Qwen3-TTS as a WAV file. */
export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(PCM.channels, 22);
  header.writeUInt32LE(PCM.rate, 24);
  header.writeUInt32LE(PCM.rate * PCM.channels * PCM.bytesPerSample, 28);
  header.writeUInt16LE(PCM.channels * PCM.bytesPerSample, 32);
  header.writeUInt16LE(PCM.bytesPerSample * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
