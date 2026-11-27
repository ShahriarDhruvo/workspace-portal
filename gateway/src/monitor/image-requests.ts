// What the gateway can tell about the image models' requests (IMAGE_MODELS), whose server reports no progress of its
// own: the model and the number of images a request asks for, read from its body as it streams to the AI server, and
// from the requests' times how long an image takes (LlmImages.pace).

/** The routes that make images, on the AI server. */
export const IMAGE_PATH = /\/images\/(?:generations|edits)$/;

/** The fields are looked for in this much of a body: one after a large inline image is not found. */
const SCAN_BYTES = 64 * 1024;
/** The server's own limit on images per request. */
const MAX_IMAGES = 10;

export interface ImageAsk {
  /** One of IMAGE_MODELS; null when the body names none of them where it was read. */
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

/** The median of the last five paces of the model that finished last; null before any. */
export function imagePace(paces: ReadonlyArray<{ model: string | null; secondsPerImage: number }>): { model: string | null; secondsPerImage: number } | null {
  const last = paces.at(-1);
  if (!last) return null;
  const recent = paces.filter((pace) => pace.model === last.model).slice(-5).map((pace) => pace.secondsPerImage).sort((a, b) => a - b);
  const middle = Math.floor(recent.length / 2);
  const secondsPerImage = recent.length % 2 === 1 ? recent[middle]! : (recent[middle - 1]! + recent[middle]!) / 2;
  return { model: last.model, secondsPerImage };
}
