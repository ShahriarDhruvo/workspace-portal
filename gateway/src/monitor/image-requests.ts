// What the gateway can tell about the image and media models' requests (media.json), whose servers report no
// progress of their own: the model a request's body names and the number of images it asks for, and from the
// requests' times how long each takes (LlmGeneration.pace).
import type { GenerationKind } from "@portal/core";
import { median } from "../lib/stats.ts";

/** The routes that make images, on the AI server. */
export const IMAGE_PATH = /\/images\/(?:generations|edits)$/;

/** `n` is looked for in this much of a body: one after a large inline image is not found. */
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
function formField(name: string, value: string): RegExp {
  return new RegExp(`[;\\s]name="${name}"[^\\r\\n]*\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n(${value})\\r\\n`);
}

function isForm(contentType: string | undefined): boolean {
  return /^multipart\/form-data/i.test(contentType ?? "");
}

const FORM_MODEL = formField("model", "[^\\r\\n]{1,200}");

/** The model a request's body names, JSON or multipart; null when it names none. */
export function namedModel(contentType: string | undefined, body: Buffer): string | null {
  if (isForm(contentType)) {
    // A client may send the field after its files (a recording, the images of an edit): it is looked for in all of it.
    for (let at = body.indexOf('name="model"'); at !== -1; at = body.indexOf('name="model"', at + 1)) {
      const model = FORM_MODEL.exec(body.subarray(Math.max(at - 1, 0), at + 512).toString("latin1"))?.[1];
      if (model !== undefined) return model;
    }
    return null;
  }
  // Parsed, not searched for: a conversation holds earlier tool calls, whose arguments may name a model too.
  try {
    const model: unknown = (JSON.parse(body.toString("utf8")) as { model?: unknown } | null)?.model;
    return typeof model === "string" && model !== "" ? model : null;
  } catch {
    return null;
  }
}

/** What an image request asks for: `named`, its model, when it is one of `models`, and `n` of its body. */
export function imageAsk(contentType: string | undefined, models: readonly string[], body: Buffer, named: string | null): ImageAsk {
  const text = body.subarray(0, SCAN_BYTES).toString("latin1");
  const count = Number((isForm(contentType) ? formField("n", "\\d{1,12}") : /"n"\s*:\s*(\d{1,12})\b/).exec(text)?.[1] ?? 1);
  return { model: named !== null && models.includes(named) ? named : null, images: Math.min(Math.max(count, 1), MAX_IMAGES) };
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

