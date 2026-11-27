// What the gateway can tell about the image and media models' requests (media.json), whose servers report no
// progress of their own: the model and the number of images a request asks for, or the media model it names, read
// from its body as it streams to the AI server, and from the requests' times how long each takes (LlmGeneration.pace).
import type { GenerationKind } from "@portal/core";
import { median } from "../lib/stats.ts";

/** The routes that make images, on the AI server. */
export const IMAGE_PATH = /\/images\/(?:generations|edits)$/;

/** The fields are looked for in this much of a body: one after a large inline image is not found. */
const SCAN_BYTES = 64 * 1024;
/** The server's own limit on images per request. */
const MAX_IMAGES = 10;

export interface ImageAsk {
  /** One of the image models; null when the body names none of them where it was read. */
  model: string | null;
  images: number;
}

/**
 * A multipart form's text field `name`, its value matching `value`: header lines may follow its Content-Disposition.
 * The parameter itself, not a file's `filename="model"`.
 */
export function formField(name: string, value: string): RegExp {
  return new RegExp(`[;\\s]name="${name}"[^\\r\\n]*\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n(${value})\\r\\n`);
}

/**
 * Reads `model` and `n` from the start of an image request's body, JSON or multipart (an edit), chunk by chunk as it
 * streams by. `onAsk` hears each change.
 */
export function imageAskReader(contentType: string | undefined, models: readonly string[], onAsk: (ask: ImageAsk) => void): (chunk: Buffer) => void {
  const form = /^multipart\/form-data/i.test(contentType ?? "");
  const modelField = form ? formField("model", "[^\\r\\n]{1,200}") : /"model"\s*:\s*"([^"\\]{1,200})"/;
  const countField = form ? formField("n", "\\d{1,12}") : /"n"\s*:\s*(\d{1,12})\b/;
  let text = "";
  let last: ImageAsk = { model: null, images: 1 };
  return (chunk) => {
    if (text.length >= SCAN_BYTES) return;
    text += chunk.subarray(0, SCAN_BYTES - text.length).toString("latin1");
    const model = modelField.exec(text)?.[1] ?? null;
    const count = Number(countField.exec(text)?.[1] ?? 1);
    const ask = { model: model !== null && models.includes(model) ? model : null, images: Math.min(Math.max(count, 1), MAX_IMAGES) };
    if (ask.model === last.model && ask.images === last.images) return;
    last = ask;
    onAsk(ask);
  };
}

/** One finished generation's time: per image for an image request, per request for a media request. */
export interface GenerationPace {
  kind: GenerationKind;
  model: string | null;
  seconds: number;
}

/** The median of the last five paces of `kind` on the model of its kind that finished last; null before any. */
export function generationPace(paces: readonly GenerationPace[], kind: GenerationKind): { model: string | null; seconds: number } | null {
  const ofKind = paces.filter((pace) => pace.kind === kind);
  const last = ofKind.at(-1);
  if (!last) return null;
  return { model: last.model, seconds: median(ofKind.filter((pace) => pace.model === last.model).slice(-5).map((pace) => pace.seconds)) };
}

/**
 * Reads `model` from the start of a media request's body, JSON or multipart (a transcription's upload), as it streams
 * by; `onModel` hears it once, when it is one of `models`.
 */
export function bodyModelReader(contentType: string | undefined, models: readonly string[], onModel: (model: string) => void): (chunk: Buffer) => void {
  const field = /^multipart\/form-data/i.test(contentType ?? "") ? formField("model", "[^\\r\\n]{1,200}") : /"model"\s*:\s*"([^"\\]{1,200})"/;
  let text = "";
  let found = false;
  return (chunk) => {
    if (found || text.length >= SCAN_BYTES) return;
    text += chunk.subarray(0, SCAN_BYTES - text.length).toString("latin1");
    const model = field.exec(text)?.[1];
    if (model === undefined || !models.includes(model)) return;
    found = true;
    onModel(model);
  };
}
