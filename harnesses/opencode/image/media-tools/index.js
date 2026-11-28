// The portal's media tools for OpenCode 2: generate_video, generate_music, synthesize_speech and transcribe_audio, one
// for each kind the AI server has a model of, and list_media_models. Each kind has a fast model, for drafts and
// everyday work, and a quality model, for final work (the portal's media.json, which harnesses/opencode/settings.ts
// passes as this plugin's options); a call names its `tier`. Each tool asks the gateway's LLM API, which queues the
// request and sends it to that model, saves what it makes in the project and returns its path and a few facts about
// it as JSON, never the file itself: the model reads a transcript, and looks at a video's frames only by extracting
// them (ffmpeg) and opening the images.
//
// Options: { baseURL: "http://<gateway>:<port>/llm/v1", media: { <kind>: { fast?: <model>, quality?: <model> } } },
// each <model> as harnesses/media.ts describes it.
import { execFile } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { answer, choose, entries, mediaListing, overrideField, PCM, speechPieces, speechRequest, tierField, wav, withRequest } from "./lib.js";

const run = promisify(execFile);

/** How often a running video job is asked about. */
const POLL_MS = 5_000;
/** The longest a tool returns of a transcript; the rest is in its file. */
const TRANSCRIPT_CHARS = 20_000;
const AUDIO_TYPES = { wav: "audio/wav", flac: "audio/flac", mp3: "audio/mpeg" };
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
/** Between two pieces of speech, in seconds. */
const PIECE_GAP_SECONDS = 0.25;
/** A cloned voice's recording is cut to this length: Qwen3-TTS takes no more. */
const REFERENCE_SECONDS = 30;
/** Longer recordings are transcribed in pieces of this length (Qwen3-ASR takes 30 minutes at most). */
const TRANSCRIBE_PIECE_SECONDS = 25 * 60;

/** Offered to the model by name; without it a tool is only reachable from a script for `execute`, as OpenCode's own generate_image is. */
const DIRECT = { codemode: false };

export default {
  id: "portal-media-tools",
  setup(ctx) {
    const { baseURL, media = {} } = ctx.options ?? {};
    if (typeof baseURL !== "string" || baseURL === "") return;
    const api = client(baseURL);
    const projectDir = async (context) => {
      try {
        const session = await ctx.session.get({ sessionID: context.sessionID });
        if (session?.location?.directory) return session.location.directory;
      } catch {
        // The plugin's own folder below.
      }
      return ctx.location.directory;
    };
    const has = (kind) => entries(media[kind]).length > 0;
    const tools = [
      has("video") && videoTool(api, media.video, projectDir),
      has("music") && musicTool(api, media.music, projectDir),
      has("speech") && speechTool(api, media.speech, projectDir),
      has("transcription") && transcriptionTool(api, media.transcription, projectDir),
    ].filter(Boolean);
    if (tools.length > 0) tools.push(listTool(api, media));
    if (tools.length > 0) ctx.tool.transform((editor) => tools.forEach((tool) => editor.add(tool)));
  },
};

/** The gateway's LLM API. A media request can wait in its queue for long (behind another person's video), so no request times out. */
function client(baseURL) {
  const call = async (method, route, { json, form, signal } = {}) => {
    const response = await fetch(`${baseURL}${route}`, {
      method,
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? form : JSON.stringify(json),
      signal,
      // Bun's own: no idle limit (by default 5 minutes without a byte ends the request).
      timeout: false,
    });
    if (!response.ok) throw new Error(`${route} answered ${response.status}: ${await errorMessage(response)}`);
    return response;
  };
  return { call };
}

async function errorMessage(response) {
  const text = await response.text().catch(() => "");
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Not JSON: the text itself.
  }
  return text.slice(0, 500) || response.statusText;
}

// --- Files -------------------------------------------------------------------------------------------------------

/** `file` (relative to the project, or absolute) as an absolute path. */
function inProject(dir, file) {
  return path.resolve(dir, file);
}

/**
 * Where to save `file`: inside the project, with one of `extensions`. Refuses a path outside the project, and an
 * existing file unless `overwrite`.
 */
async function outputPath(dir, file, extensions, overwrite) {
  if (typeof file !== "string" || file.trim() === "") throw new Error("`path` is required: where in the project to save the file.");
  const target = path.resolve(dir, file);
  const relative = path.relative(dir, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`\`path\` must be a file inside the project (${dir}).`);
  const extension = path.extname(target).toLowerCase().slice(1);
  if (!extensions.includes(extension)) throw new Error(`\`path\` must end in .${extensions.join(", .")}.`);
  if (!overwrite && (await stat(target).catch(() => null))) throw new Error(`${relative} exists. Choose another path, or pass overwrite: true to replace it.`);
  await mkdir(path.dirname(target), { recursive: true });
  return { target, relative, extension };
}

/** Writes all of `bytes` to `target` at once: a reader never sees half a file. */
async function save(target, bytes) {
  const partial = `${target}.${randomBytes(4).toString("hex")}.part`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

async function dataUrl(dir, file, types) {
  const absolute = inProject(dir, file);
  const type = types[path.extname(absolute).toLowerCase()];
  if (type === undefined) throw new Error(`${file} must be a ${Object.keys(types).join(", ")} file.`);
  return `data:${type};base64,${(await readFile(absolute)).toString("base64")}`;
}

/** A scratch folder for ffmpeg's files, removed after `work`. */
async function scratch(work) {
  const dir = path.join(os.tmpdir(), `media-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ffmpeg = (args) => run("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });

/** What ffprobe says of a media file: its duration and streams, or null without ffprobe. */
async function probe(file) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels", "-of", "json", file]);
    const info = JSON.parse(stdout);
    const duration = Number(info.format?.duration);
    return { seconds: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null, streams: info.streams ?? [] };
  } catch {
    return null;
  }
}

function streams(probed) {
  if (probed === null) return null;
  const parts = probed.streams.map((stream) =>
    stream.codec_type === "video"
      ? `${stream.codec_name} ${stream.width}x${stream.height}`
      : stream.codec_type === "audio"
        ? `${stream.codec_name} ${stream.sample_rate} Hz ${stream.channels === 1 ? "mono" : stream.channels === 2 ? "stereo" : `${stream.channels} channels`}`
        : null,
  );
  return parts.filter(Boolean).join(", ") || null;
}

const seconds = (started) => Math.round((Date.now() - started) / 100) / 10;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

const seedField = { type: "integer", minimum: 0, maximum: 4294967295, description: "The same seed with the same request makes the same result. Leave it out for a new one; the answer says the seed used." };
const overwriteField = { type: "boolean", description: "Replace a file already at `path`. Default false." };
const newSeed = () => randomInt(0, 2 ** 32);

// --- list_media_models -------------------------------------------------------------------------------------------

function listTool(api, media) {
  return {
    name: "list_media_models",
    options: DIRECT,
    description:
      "Lists the AI server's image, video, music, speech and transcription models by tier (fast and quality): what each is for and how long it takes, which are loaded now (they start without waiting for a model swap), and the video that holds the server, if one does. Call it before planning a media piece.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      let live = null;
      try {
        live = await (await api.call("GET", "/media", { signal: context.signal })).json();
      } catch {
        // Unreachable for now: what the settings say, without what is loaded.
      }
      const facts = { status: "ok", ...mediaListing(live?.kinds ?? media, Array.isArray(live?.loaded) ? live.loaded : null), video_hold: live?.videoHold ?? null };
      return { content: JSON.stringify(facts), metadata: facts };
    },
  };
}

// --- generate_video ----------------------------------------------------------------------------------------------

function videoTool(api, tiers, projectDir) {
  const all = entries(tiers);
  const sizes = [...new Set(all.flatMap((entry) => entry.sizes))];
  const min = Math.min(...all.map((entry) => entry.seconds.min));
  const max = Math.max(...all.map((entry) => entry.seconds.max));
  const perTier = all.map((entry) => `${entry.tier}: ${entry.seconds.min} to ${entry.seconds.max} s at ${entry.sizes.join(" or ")}`).join("; ");
  return {
    name: "generate_video",
    options: DIRECT,
    description: [
      "Makes a short video with its own soundtrack (sound effects and ambience, no music or speech you control) from a text prompt, and saves it as an MP4 in the project.",
      "Describe one shot in under about 150 words: subject, action, camera, light, style and the sounds. Optional first_frame and last_frame images (PNG, JPEG or WebP in the project) make it start or end on that picture and take its aspect ratio; make them with generate_image first.",
      "It takes minutes, during which the AI server makes nothing else for anyone: plan every clip before making any, try ideas with the fast tier, and make the final clips with the quality tier.",
    ].join(" "),
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The shot, in English." },
        path: { type: "string", description: "Where in the project to save it, ending in .mp4, such as media/<piece>/clips/shot-01.mp4." },
        tier: tierField(tiers, "video"),
        model_override: overrideField(tiers),
        seconds: { type: "number", minimum: min, maximum: max, description: `Length in seconds (${perTier}). Default 5.` },
        size: { type: "string", enum: sizes, description: `Width x height (${perTier}); each tier's first is its default. With a keyframe, the frame's aspect ratio is kept within this many pixels.` },
        first_frame: { type: "string", description: "An image in the project the video starts on." },
        last_frame: { type: "string", description: "An image in the project the video ends on." },
        seed: seedField,
        overwrite: overwriteField,
      },
      required: ["prompt", "path", "tier"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const started = Date.now();
      const signal = context.signal;
      const { entry, note } = choose(tiers, "video", input);
      const dir = await projectDir(context);
      const out = await outputPath(dir, input.path, ["mp4"], input.overwrite === true);
      const length = input.seconds ?? Math.min(Math.max(5, entry.seconds.min), entry.seconds.max);
      if (length < entry.seconds.min || length > entry.seconds.max) throw new Error(`The ${entry.tier} video model (${entry.name}) makes ${entry.seconds.min} to ${entry.seconds.max} s.`);
      const size = input.size ?? entry.sizes[0];
      if (!entry.sizes.includes(size)) throw new Error(`The ${entry.tier} video model (${entry.name}) makes ${entry.sizes.join(" or ")}${entry.tier === "fast" ? ": use the quality tier for others" : ""}.`);
      const seed = input.seed ?? newSeed();
      const body = withRequest({ model: entry.model, prompt: input.prompt, size, seconds: length, gufo: { seed } }, entry.request);
      if (input.first_frame) body.first_frame = await dataUrl(dir, input.first_frame, IMAGE_TYPES);
      if (input.last_frame) body.last_frame = await dataUrl(dir, input.last_frame, IMAGE_TYPES);

      await context.progress({ title: `Waiting for the video model: ${out.relative}` });
      const job = await (await api.call("POST", "/videos", { json: body, signal })).json();
      const id = job?.id;
      if (typeof id !== "string") throw new Error("The video server's answer holds no job id.");
      try {
        let state = job;
        while (state.status === "queued" || state.status === "in_progress") {
          const percent = typeof state.progress === "number" ? ` ${Math.round(state.progress)}%` : "";
          await context.progress({ title: `Making ${out.relative}:${percent} (${Math.round(seconds(started))} s)`, job: id, status: state.status, progress: state.progress });
          await sleep(POLL_MS, signal);
          state = await (await api.call("GET", `/videos/${id}`, { signal })).json();
        }
        if (state.status !== "completed") throw new Error(`The video job ${state.status}${state.error?.message ? `: ${state.error.message}` : ""}.`);
        const video = Buffer.from(await (await api.call("GET", `/videos/${id}/content`, { signal })).arrayBuffer());
        await save(out.target, video);
      } catch (error) {
        // Stopped, or it went wrong on the way: the job is cancelled and its files deleted, which also lets the AI
        // server go on with other work.
        if (signal?.aborted || !(error instanceof Error && error.message.startsWith("The video job"))) await api.call("DELETE", `/videos/${id}`).catch(() => {});
        throw error;
      }
      const probed = await probe(out.target);
      return answer(
        {
          file_path: out.relative,
          tier: entry.tier,
          model_used: entry.model,
          elapsed_sec: seconds(started),
          duration_sec: probed?.seconds ?? length,
          size,
          seed,
          streams: streams(probed),
          check: `Extract frames and look at them: ffmpeg -v error -ss 0 -i ${out.relative} -frames:v 1 /tmp/frame-a.png (and the middle and the end).`,
        },
        note,
      );
    },
  };
}

// --- generate_music ----------------------------------------------------------------------------------------------

function musicTool(api, tiers, projectDir) {
  return {
    name: "generate_music",
    options: DIRECT,
    description: [
      "Makes a piece of music, instrumental or sung, and saves it in the project (WAV, FLAC or MP3).",
      "`prompt` is the style: genre, mood, instruments, tempo, voice. `lyrics` are the words with section tags ([verse], [chorus], [bridge]); leave them out for an instrumental.",
      "Try a style with the fast tier, then make the final track with the quality tier.",
    ].join(" "),
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The style, as tags or a sentence: such as 'warm lo-fi hip hop, mellow piano, vinyl crackle, 80 bpm'." },
        lyrics: { type: "string", description: "The words to sing, with [verse], [chorus] and the like on their own lines. Leave out for an instrumental." },
        duration: { type: "number", minimum: 10, maximum: 600, description: "Length in seconds, 10 to 600." },
        path: { type: "string", description: "Where in the project to save it, ending in .wav, .flac or .mp3, such as media/<piece>/music/theme.wav." },
        tier: tierField(tiers, "music"),
        model_override: overrideField(tiers),
        seed: seedField,
        overwrite: overwriteField,
      },
      required: ["prompt", "duration", "path", "tier"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const started = Date.now();
      const { entry, note } = choose(tiers, "music", input);
      const dir = await projectDir(context);
      const out = await outputPath(dir, input.path, Object.keys(AUDIO_TYPES), input.overwrite === true);
      const seed = input.seed ?? newSeed();
      const body = withRequest(
        { model: entry.model, prompt: input.prompt, lyrics: input.lyrics?.trim() ? input.lyrics : "[Instrumental]", duration: input.duration, response_format: out.extension, seed },
        entry.request,
      );
      await context.progress({ title: `Making ${out.relative} (${input.duration} s of music, ${entry.tier})` });
      const audio = Buffer.from(await (await api.call("POST", "/audio/music", { json: body, signal: context.signal })).arrayBuffer());
      await save(out.target, audio);
      const probed = await probe(out.target);
      return answer({ file_path: out.relative, tier: entry.tier, model_used: entry.model, elapsed_sec: seconds(started), duration_sec: probed?.seconds ?? input.duration, seed, streams: streams(probed) }, note);
    },
  };
}

// --- synthesize_speech -------------------------------------------------------------------------------------------

function speechTool(api, tiers, projectDir) {
  const all = entries(tiers);
  const qwen = all.find((entry) => entry.api === "qwen3-tts");
  const voices = Object.assign({}, ...all.map((entry) => entry.voices ?? {}));
  const languages = [...new Set(all.flatMap((entry) => entry.languages ?? []))];
  const tiersWith = (has) => [...new Set(all.filter(has).map((entry) => entry.tier))].join(" and ");
  const tagged = tiersWith((entry) => entry.api === "fish-speech");
  const properties = {
    input: { type: "string", description: `The words to say.${tagged ? ` In the ${tagged} tier a tag in square brackets before a phrase sets its delivery and is not spoken: [whisper], [laughing], [excited], [sad].` : ""}` },
    path: { type: "string", description: "Where in the project to save it, ending in .wav, such as media/<piece>/speech/line-01.wav." },
    tier: tierField(tiers, "speech"),
    model_override: overrideField(tiers),
  };
  if (qwen && Object.keys(voices).length > 0) {
    properties.voice = {
      type: "string",
      enum: Object.keys(voices),
      description: `A built-in voice (${Object.entries(voices).map(([name, about]) => `${name}: ${about}`).join("; ")}). Default ${Object.keys(voices)[0]}. Built-in voices are the ${qwen.tier} tier's.`,
    };
    properties.instructions = { type: "string", description: `How to say it, in English: "Speak warmly and slowly", "Excited, a little out of breath". With a built-in voice or a voice_description (${qwen.tier} tier).` };
  }
  if (qwen && languages.length > 0) properties.language = { type: "string", enum: ["auto", ...languages], description: `The language of the text. Default auto. The ${qwen.tier} tier's; the other detects it.` };
  const designs = tiersWith((entry) => entry.design);
  if (designs) properties.voice_description = { type: "string", description: `A new voice, described: "a gravelly old sea captain, slow and deep". The same description and seed give the same voice (${designs} tier).` };
  const clones = tiersWith((entry) => entry.clone || entry.api === "fish-speech");
  if (clones) {
    properties.reference_audio = { type: "string", description: `A clean recording in the project (WAV, FLAC or MP3, 5 to 30 s; longer is cut) of the voice to speak in (${clones} tier).` };
    properties.reference_text = { type: "string", description: "What reference_audio says, word for word. It makes the cloned voice closer." };
  }
  properties.seed = seedField;
  properties.overwrite = overwriteField;
  // Said per tier in the description: with only the fields' own notes, an agent tried a built-in and then a described voice on a tier that takes neither.
  const takes = (entry) => {
    const ways = [entry.api === "qwen3-tts" && entry.voices ? "`voice` with `instructions`" : null, entry.design ? "`voice_description`" : null, entry.clone || entry.api === "fish-speech" ? "`reference_audio`" : null].filter(Boolean);
    return `${entry.tier} (${entry.name}) takes ${ways.join(" or ")}${entry.api === "fish-speech" ? " or no voice setting at all, for its own voice" : ""}`;
  };
  return {
    name: "synthesize_speech",
    options: DIRECT,
    description: [
      "Reads text aloud and saves it as a WAV in the project: narration, dialogue, a voice-over.",
      "Pick a voice one of three ways: a built-in `voice` (with `instructions` for the delivery), a `voice_description` for a new one, or `reference_audio` to speak in the voice of a recording.",
      `Not every tier takes every way: ${all.map(takes).join("; ")}.`,
      "One voice per call: make each speaker's lines separately with the same voice settings and seed, and join the files with ffmpeg.",
    ].join(" "),
    input: { type: "object", properties, required: ["input", "path", "tier"], additionalProperties: false },
    async execute(input, context) {
      const started = Date.now();
      const { entry, note } = choose(tiers, "speech", input);
      const dir = await projectDir(context);
      if (typeof input.input !== "string" || input.input.trim() === "") throw new Error("`input` is required: the words to say.");
      if (input.voice_description && input.reference_audio) throw new Error("Give voice_description or reference_audio, not both.");
      const out = await outputPath(dir, input.path, ["wav"], input.overwrite === true);
      const seed = input.seed ?? newSeed();
      const reference = input.reference_audio ? await referenceWav(inProject(dir, input.reference_audio)) : null;
      const voiced = speechRequest(entry, input, reference, qwen);
      await context.progress({ title: `Speaking ${out.relative} (${entry.tier})` });
      let audio;
      if (entry.api === "fish-speech") {
        const body = withRequest({ ...voiced.request, input: input.input, response_format: "wav", seed }, entry.request);
        audio = Buffer.from(await (await api.call("POST", "/audio/speech", { json: body, signal: context.signal })).arrayBuffer());
      } else {
        const pieces = speechPieces(input.input);
        const pcm = [];
        for (const [index, piece] of pieces.entries()) {
          if (pieces.length > 1) await context.progress({ title: `Speaking ${out.relative}: part ${index + 1} of ${pieces.length}` });
          if (index > 0) pcm.push(Buffer.alloc(Math.round(PIECE_GAP_SECONDS * PCM.rate) * PCM.bytesPerSample));
          const body = withRequest({ ...voiced.request, input: piece, language: input.language ?? "auto", response_format: "pcm", seed }, entry.request);
          pcm.push(Buffer.from(await (await api.call("POST", "/audio/speech", { json: body, signal: context.signal })).arrayBuffer()));
        }
        audio = wav(Buffer.concat(pcm));
      }
      await save(out.target, audio);
      const probed = await probe(out.target);
      return answer({ file_path: out.relative, tier: entry.tier, model_used: voiced.request.model, elapsed_sec: seconds(started), duration_sec: probed?.seconds ?? null, voice: voiced.voice, seed, streams: streams(probed) }, note);
    },
  };
}

/** A voice's recording as both speech models take it: a mono 24 kHz WAV of at most REFERENCE_SECONDS. */
async function referenceWav(source) {
  if (!(await stat(source).catch(() => null))?.isFile()) throw new Error(`${source} is not a file.`);
  return scratch(async (dir) => {
    const target = path.join(dir, "reference.wav");
    try {
      await ffmpeg(["-i", source, "-vn", "-t", String(REFERENCE_SECONDS), "-ac", "1", "-ar", String(PCM.rate), "-c:a", "pcm_s16le", target]);
    } catch (error) {
      throw new Error(`ffmpeg could not read ${source} as audio: ${String(error.stderr ?? error.message).trim().slice(0, 300)}`);
    }
    return readFile(target);
  });
}

// --- transcribe_audio --------------------------------------------------------------------------------------------

function transcriptionTool(api, tiers, projectDir) {
  const subtitled = entries(tiers).filter((entry) => entry.subtitles);
  const timed = subtitled.length > 0;
  return {
    name: "transcribe_audio",
    options: DIRECT,
    description: [
      "Writes down what is said in an audio or video file of the project, and returns the text.",
      `With \`path\` it also saves the transcript there: .txt for the text${timed ? `, .srt or .vtt for subtitles with times, .json for segments with times (these need the ${subtitled.map((entry) => entry.tier).join(" and ")} tier, which is then used)` : ""}.`,
      "Use it to check speech you generated: compare the transcript with the script.",
    ].join(" "),
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "The audio or video file in the project." },
        tier: tierField(tiers, "transcription"),
        model_override: overrideField(tiers),
        language: { type: "string", description: "The spoken language as an ISO 639-1 code, such as en. Leave out to detect it." },
        prompt: { type: "string", description: "Names and terms the recording uses, so they are spelled right: 'Ayesha, Strix Halo, llama-swap'." },
        path: { type: "string", description: `Where in the project to save the transcript: .txt${timed ? ", .srt, .vtt or .json" : ""}.` },
        overwrite: overwriteField,
      },
      required: ["file", "tier"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const started = Date.now();
      let { entry, note } = choose(tiers, "transcription", input);
      const dir = await projectDir(context);
      const source = inProject(dir, input.file);
      if (!(await stat(source).catch(() => null))?.isFile()) throw new Error(`${input.file} is not a file.`);
      const out = input.path ? await outputPath(dir, input.path, timed ? ["txt", "srt", "vtt", "json"] : ["txt"], input.overwrite === true) : null;
      const format = out === null || out.extension === "txt" ? "json" : out.extension === "json" ? "verbose_json" : out.extension;
      if (format !== "json" && !entry.subtitles) {
        const [withTimes] = subtitled;
        note = `Times need the ${withTimes.tier} tier (${withTimes.name}): it made this transcript.`;
        entry = withTimes;
      }
      const ask = async (audio) => {
        const form = new FormData();
        form.set("model", entry.model);
        form.set("response_format", format);
        if (input.language) form.set("language", input.language);
        if (input.prompt) form.set("prompt", input.prompt);
        form.set("file", new Blob([audio], { type: "audio/flac" }), "audio.flac");
        return (await api.call("POST", "/audio/transcriptions", { form, signal: context.signal })).text();
      };
      await context.progress({ title: `Transcribing ${input.file} (${entry.tier})` });
      let raw = "";
      let parsed;
      let text;
      if (format === "json") {
        // Plain text: a long recording goes in pieces, whose texts are joined.
        const pieces = await flacPieces(source, TRANSCRIBE_PIECE_SECONDS);
        const texts = [];
        let language = null;
        for (const [index, piece] of pieces.entries()) {
          if (pieces.length > 1) await context.progress({ title: `Transcribing ${input.file}: part ${index + 1} of ${pieces.length}` });
          const part = JSON.parse(await ask(piece));
          texts.push(String(part.text ?? "").trim());
          language ??= part.language ?? null;
        }
        text = texts.filter(Boolean).join(" ");
        parsed = { text, ...(language ? { language } : {}) };
      } else {
        const [whole] = await flacPieces(source, Infinity);
        raw = await ask(whole);
        parsed = format === "verbose_json" ? JSON.parse(raw) : null;
        text = parsed ? String(parsed.text ?? "") : raw;
      }
      if (out !== null) await save(out.target, out.extension === "txt" ? `${text.trim()}\n` : out.extension === "json" ? `${JSON.stringify(parsed, null, 2)}\n` : raw);
      const shown = text.length > TRANSCRIPT_CHARS ? `${text.slice(0, TRANSCRIPT_CHARS)} [… ${text.length - TRANSCRIPT_CHARS} more characters${out ? ` in ${out.relative}` : ""}]` : text;
      return answer(
        { file_path: out?.relative ?? null, tier: entry.tier, model_used: entry.model, elapsed_sec: seconds(started), language: parsed?.language ?? input.language ?? null, characters: text.length, transcript: shown },
        note,
      );
    },
  };
}

/**
 * The recording as the transcription models take it best: 16 kHz mono FLAC, a tenth of the size of a WAV and without
 * a video's picture, in pieces of at most `pieceSeconds`.
 */
async function flacPieces(source, pieceSeconds) {
  return scratch(async (dir) => {
    const split = Number.isFinite(pieceSeconds) ? ["-f", "segment", "-segment_time", String(pieceSeconds), "-reset_timestamps", "1"] : [];
    try {
      await ffmpeg(["-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", ...split, path.join(dir, split.length > 0 ? "piece-%03d.flac" : "piece-000.flac")]);
    } catch (error) {
      throw new Error(`ffmpeg could not read ${source} as audio: ${String(error.stderr ?? error.message).trim().slice(0, 300)}`);
    }
    const files = (await readdir(dir)).filter((name) => name.endsWith(".flac")).sort();
    return Promise.all(files.map((name) => readFile(path.join(dir, name))));
  });
}
