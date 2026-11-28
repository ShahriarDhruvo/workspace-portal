// What the gateway can tell about the image and media models' requests (media.json), whose servers report no
// progress of their own: the model and the number of images a request asks for, or the media model it names, read
// from the start of its body, and from the requests' times how long each takes (LlmGeneration.pace).
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

function isForm(contentType: string | undefined): boolean {
  return /^multipart\/form-data/i.test(contentType ?? "");
}

/** The body's `model` field, JSON or multipart, when it is one of `models`. */
function modelIn(contentType: string | undefined, models: readonly string[], text: string): string | null {
  const model = (isForm(contentType) ? formField("model", "[^\\r\\n]{1,200}") : /"model"\s*:\s*"([^"\\]{1,200})"/).exec(text)?.[1];
  return model !== undefined && models.includes(model) ? model : null;
}

/** What an image request asks for: `model` and `n` of its body, JSON or multipart (an edit). */
export function imageAsk(contentType: string | undefined, models: readonly string[], body: Buffer): ImageAsk {
  const text = body.subarray(0, SCAN_BYTES).toString("latin1");
  const count = Number((isForm(contentType) ? formField("n", "\\d{1,12}") : /"n"\s*:\s*(\d{1,12})\b/).exec(text)?.[1] ?? 1);
  return { model: modelIn(contentType, models, text), images: Math.min(Math.max(count, 1), MAX_IMAGES) };
}

/** The model a media request's body names, JSON or multipart (a transcription's upload), when it is one of `models`. */
export function mediaModelNamed(contentType: string | undefined, models: readonly string[], body: Buffer): string | null {
  return modelIn(contentType, models, body.subarray(0, SCAN_BYTES).toString("latin1"));
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

