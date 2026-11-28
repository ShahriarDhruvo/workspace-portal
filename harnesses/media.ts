// The media registry (PORTAL_DATA_DIR/config/models/media.json): for each kind of media the AI server makes, its fast
// model, for drafts and everyday work, and its quality model, for final work, with what each is good at and how long
// it takes. The one place the admin names them: the gateway routes and counts their requests by it, OpenCode's image
// tool and the portal's media tools (opencode/image/media-tools) use it, and the agent's instructions are written
// from it (opencode/settings.ts). A kind with one model names it under either tier, and both tiers then use it.
// Changing an image is a kind of its own (imageEdit), because the best model for it need not be the one that makes
// new images: OpenCode sends a request with input images only to a model named there.
import fs from "node:fs";
import { isRecord } from "@portal/core";
import { stripJsonComments } from "./models.ts";
import { AgentConfigError } from "./shared.ts";

/** What a media model makes. Both image kinds go through OpenCode's own generate_image; the rest through the portal's tools. */
export const MEDIA_KINDS = ["image", "imageEdit", "video", "music", "speech", "transcription"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MEDIA_TIERS = ["fast", "quality"] as const;
export type MediaTier = (typeof MEDIA_TIERS)[number];
/** The speech servers the portal's speech tool knows how to ask: Gufo's Qwen3-TTS, or Fish Speech's adapter. */
export const SPEECH_APIS = ["qwen3-tts", "fish-speech"] as const;
export type SpeechApi = (typeof SPEECH_APIS)[number];

/** A model id as the AI server names it: `Qwen-Image-2.1`, `models/Qwen/Qwen3-8B`. No dot segments: it becomes part of a path. */
export const MEDIA_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;

export interface MediaModel {
  /** The id the AI server serves it under (llama-swap's). */
  model: string;
  /** Its name for people; the id when not given. */
  name: string;
  /** How long it takes, in words ("about 25 s an image"); "" when not given. */
  time: string;
  /** What it is the better choice for ("drafts, storyboards"); "" when not given. */
  bestFor: string;
  /** It runs beside the LLM: using it stops nothing and waits for no swap. */
  besideLlm: boolean;
  /** Fields every request to it carries, added to the tool's own (a preset, for instance). */
  request: Readonly<Record<string, unknown>>;
  /** video: the sizes it makes ("512x512"); the first is the default. image, imageEdit: the sizes it makes besides the server's default. */
  sizes?: readonly string[];
  /** video: the shortest and longest clip, in seconds. */
  seconds?: { min: number; max: number };
  /** speech: how to ask it. */
  api?: SpeechApi;
  /** speech, qwen3-tts: its built-in voices by name, each with who it sounds like; the first is the default. */
  voices?: Readonly<Record<string, string>>;
  /** speech, qwen3-tts: the languages it speaks, by the names it takes. */
  languages?: readonly string[];
  /** speech, qwen3-tts: the model that clones a voice from a recording. */
  clone?: string;
  /** speech, qwen3-tts: the model that makes a voice from a description. */
  design?: string;
  /** transcription: it writes subtitles with times (srt, vtt, verbose_json segments). */
  subtitles?: boolean;
}

export type MediaTiers = Readonly<Partial<Record<MediaTier, MediaModel>>>;
export type MediaRegistry = Readonly<Partial<Record<MediaKind, MediaTiers>>>;

/** The fields each kind's entries may have, beyond the common ones. */
const KIND_FIELDS: Record<MediaKind, readonly string[]> = {
  image: ["sizes"],
  imageEdit: ["sizes"],
  video: ["sizes", "seconds"],
  music: [],
  speech: ["api", "voices", "languages", "clone", "design"],
  transcription: ["subtitles"],
};
const COMMON_FIELDS = ["model", "name", "time", "bestFor", "besideLlm", "request"];
const SIZE = /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
/** Request fields a tier may not set: the tool's own. */
const RESERVED_REQUEST_FIELDS = ["model", "prompt", "input", "file", "response_format", "stream", "stream_format"];

/** Reads the registry; a missing file is an empty registry. Throws AgentConfigError naming every problem. */
export function loadMediaRegistry(file: string): MediaRegistry {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new AgentConfigError(`cannot read the media registry ${file}: ${(error as Error).message}`);
  }
  return parseMediaRegistry(text, file);
}

export function parseMediaRegistry(text: string, label: string): MediaRegistry {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new AgentConfigError(`the media registry ${label} is not valid JSON: ${(error as Error).message}`);
  }
  const problems: string[] = [];
  const registry: Partial<Record<MediaKind, MediaTiers>> = {};
  if (!isRecord(value)) throw new AgentConfigError(`the media registry ${label} must contain a JSON object`);
  for (const [kind, tiers] of Object.entries(value)) {
    if (kind === "$schema" || kind === "$version") continue;
    if (!(MEDIA_KINDS as readonly string[]).includes(kind)) {
      problems.push(`"${kind}" is no kind of media: use ${MEDIA_KINDS.join(", ")}`);
      continue;
    }
    if (!isRecord(tiers)) {
      problems.push(`${kind} must be an object with "fast" and/or "quality"`);
      continue;
    }
    const parsed: Partial<Record<MediaTier, MediaModel>> = {};
    for (const [tier, entry] of Object.entries(tiers)) {
      if (!(MEDIA_TIERS as readonly string[]).includes(tier)) {
        problems.push(`${kind}.${tier}: the tiers are "fast" and "quality"`);
        continue;
      }
      const model = parseEntry(kind as MediaKind, `${kind}.${tier}`, entry, problems);
      if (model !== null) parsed[tier as MediaTier] = model;
    }
    if (Object.keys(tiers).length === 0) problems.push(`${kind} names no model: give it "fast", "quality" or both, or leave it out`);
    if (Object.keys(parsed).length > 0) registry[kind as MediaKind] = parsed;
  }
  if (problems.length > 0) throw new AgentConfigError(`the media registry ${label} is not valid:\n  - ${problems.join("\n  - ")}`);
  return registry;
}

function parseEntry(kind: MediaKind, where: string, entry: unknown, problems: string[]): MediaModel | null {
  if (!isRecord(entry)) {
    problems.push(`${where} must be an object with a "model"`);
    return null;
  }
  const allowed = [...COMMON_FIELDS, ...KIND_FIELDS[kind]];
  for (const key of Object.keys(entry)) if (!allowed.includes(key)) problems.push(`${where}.${key} is not a field of a ${kind} model (fields: ${allowed.join(", ")})`);
  const before = problems.length;
  const id = (key: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "string" && MEDIA_MODEL_ID.test(value)) return value;
    problems.push(`${where}.${key} must be a model id such as Qwen-Image-2.1`);
    return undefined;
  };
  const words = (key: string, max: number): string => {
    const value = entry[key];
    if (value === undefined) return "";
    if (typeof value === "string" && value.length <= max && !/[\r\n]/.test(value)) return value.trim();
    problems.push(`${where}.${key} must be one line of at most ${max} characters`);
    return "";
  };
  const list = (key: string, pattern: RegExp): string[] | undefined => {
    const value = entry[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && pattern.test(item)) && new Set(value).size === value.length) return value as string[];
    problems.push(`${where}.${key} must be a list of distinct names`);
    return undefined;
  };
  const model = id("model", entry.model);
  if (entry.model === undefined) problems.push(`${where}.model is required: the id the AI server serves it under`);
  if (entry.besideLlm !== undefined && typeof entry.besideLlm !== "boolean") problems.push(`${where}.besideLlm must be true or false`);
  const request = entry.request ?? {};
  if (!isRecord(request)) problems.push(`${where}.request must be an object of request fields`);
  else for (const key of RESERVED_REQUEST_FIELDS) if (key in request) problems.push(`${where}.request may not set "${key}": the tool sets it`);
  const result: MediaModel = {
    model: model ?? "",
    name: words("name", 80) || (model ?? ""),
    time: words("time", 120),
    bestFor: words("bestFor", 240),
    besideLlm: entry.besideLlm === true,
    request: isRecord(request) ? request : {},
  };
  if (kind === "image" || kind === "imageEdit") {
    const sizes = list("sizes", SIZE);
    if (sizes) result.sizes = sizes;
  }
  if (kind === "video") {
    const sizes = list("sizes", SIZE);
    if (sizes === undefined) problems.push(`${where}.sizes is required: the sizes it makes, such as ["512x512", "1344x768"]`);
    const seconds = entry.seconds;
    if (isRecord(seconds) && isSeconds(seconds.min) && isSeconds(seconds.max) && seconds.min <= seconds.max) result.seconds = { min: seconds.min, max: seconds.max };
    else problems.push(`${where}.seconds is required: { "min": 5, "max": 14 }, the clip lengths it makes`);
    if (sizes) result.sizes = sizes;
  }
  if (kind === "speech") {
    if ((SPEECH_APIS as readonly unknown[]).includes(entry.api)) result.api = entry.api as SpeechApi;
    else problems.push(`${where}.api is required: ${SPEECH_APIS.map((api) => `"${api}"`).join(" or ")}, how the speech tool asks it`);
    const voices = voiceMap(entry.voices);
    if (entry.voices !== undefined && voices === undefined) problems.push(`${where}.voices must map each voice's name to who it sounds like: { "ryan": "male, English" }`);
    const languages = list("languages", WORD);
    const clone = id("clone", entry.clone);
    const design = id("design", entry.design);
    if (result.api === "qwen3-tts" && entry.voices === undefined) problems.push(`${where}.voices is required with "qwen3-tts": its built-in voices, the default first`);
    if (result.api !== "qwen3-tts" && [voices, languages, clone, design].some((field) => field !== undefined)) {
      problems.push(`${where}: voices, languages, clone and design belong to "qwen3-tts" models`);
    }
    Object.assign(result, voices && { voices }, languages && { languages }, clone && { clone }, design && { design });
  }
  if (kind === "transcription" && entry.subtitles !== undefined) {
    if (typeof entry.subtitles === "boolean") result.subtitles = entry.subtitles;
    else problems.push(`${where}.subtitles must be true or false`);
  }
  return problems.length === before ? result : null;
}

function voiceMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  const voices = Object.entries(value);
  if (!voices.every(([name, about]) => WORD.test(name) && typeof about === "string" && about.length <= 120 && !/[\r\n]/.test(about))) return undefined;
  return Object.fromEntries(voices) as Record<string, string>;
}

function isSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 600;
}

/** The model a kind's tier uses: its own, else the other tier's (a kind with one model); null when the kind has none. */
export function mediaModel(registry: MediaRegistry, kind: MediaKind, tier: MediaTier): MediaModel | null {
  const tiers = registry[kind];
  if (!tiers) return null;
  return tiers[tier] ?? tiers[tier === "fast" ? "quality" : "fast"] ?? null;
}

/** Every model id a kind's requests may name: its tiers' and a speech model's clone and design models. */
export function mediaModelIds(registry: MediaRegistry, kind: MediaKind): string[] {
  const ids = MEDIA_TIERS.flatMap((tier) => {
    const entry = registry[kind]?.[tier];
    return entry ? [entry.model, ...(entry.clone ? [entry.clone] : []), ...(entry.design ? [entry.design] : [])] : [];
  });
  return [...new Set(ids)];
}

/** The model ids of every kind that run beside the LLM. */
export function besideLlmIds(registry: MediaRegistry): Set<string> {
  const ids = new Set<string>();
  for (const kind of MEDIA_KINDS) {
    for (const tier of MEDIA_TIERS) {
      const entry = registry[kind]?.[tier];
      if (!entry?.besideLlm) continue;
      for (const id of [entry.model, entry.clone, entry.design]) if (id) ids.add(id);
    }
  }
  return ids;
}

/** The models of /v1/images/*: those that make new images, fast first, then those that only edit. */
export function imageModels(registry: MediaRegistry): string[] {
  return [...new Set([...mediaModelIds(registry, "image"), ...mediaModelIds(registry, "imageEdit")])];
}
