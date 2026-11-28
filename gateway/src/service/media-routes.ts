// The media models' routes (media.json): which request is which kind's, and where on the AI server it goes. Speech
// and transcription are OpenAI's routes, which llama-swap serves itself, picking the model by the request's own; music
// is the portal's own, a synchronous POST that returns the track (llm-server/apps/acestep/acestep-sync.py); video is
// OpenAI's job API, whose jobs run after the request that created them has ended (video-jobs.ts). Music and video go
// to the model's own routes (MEDIA_MODEL_PATH): llama-swap routes neither, so the gateway reads the model from the
// body first, and a job's later requests go to the model that made it.
import { MEDIA_TIERS, mediaModel, mediaModelIds, type MediaKind, type MediaRegistry } from "@portal/harnesses";
import { formField } from "../monitor/image-requests.ts";

/** What a request does to a video job: create one, or read, download or cancel the job `id`. */
export type VideoCall = { op: "create" } | { op: "status" | "content" | "cancel"; id: string };

export interface MediaRoute {
  kind: Exclude<MediaKind, "image" | "imageEdit">;
  /**
   * body: the model is read from the body before the request goes on (music, a video's create), to the model's own
   * routes; job: the model is the job's; root: the request goes to the server's own route, which picks the model.
   */
  model: "body" | "job" | "root";
  /** What it does to a video job; null for the other kinds. */
  video: VideoCall | null;
}

/** A job id as the video server makes them; anything else is no job of its. */
const JOB_ID = "([A-Za-z0-9][A-Za-z0-9_-]{0,127})";

/** By the path after /v1/, as the service API matches its routes. */
export const MEDIA_ROUTES: ReadonlyArray<{
  kind: MediaRoute["kind"];
  method: "GET" | "POST" | "DELETE";
  path: RegExp;
  model: MediaRoute["model"];
  video?: (id: string) => VideoCall;
}> = [
  { kind: "speech", method: "POST", path: /^audio\/speech$/, model: "root" },
  { kind: "transcription", method: "POST", path: /^audio\/transcriptions$/, model: "root" },
  { kind: "music", method: "POST", path: /^audio\/music$/, model: "body" },
  { kind: "video", method: "POST", path: /^videos$/, model: "body", video: () => ({ op: "create" }) },
  { kind: "video", method: "GET", path: new RegExp(`^videos/${JOB_ID}$`), model: "job", video: (id) => ({ op: "status", id }) },
  { kind: "video", method: "GET", path: new RegExp(`^videos/${JOB_ID}/content$`), model: "job", video: (id) => ({ op: "content", id }) },
  { kind: "video", method: "DELETE", path: new RegExp(`^videos/${JOB_ID}$`), model: "job", video: (id) => ({ op: "cancel", id }) },
];

/** Where `model`'s own routes are on the AI server: "" (its root) or the MEDIA_MODEL_PATH with the id in it. */
export function modelPrefix(modelPath: string, model: string): string {
  return modelPath.replace("{model}", model);
}

/**
 * The media route of a request for `pathname` on the AI server ("/v1/audio/speech"); null for any other request, a
 * kind the registry has no model of included, which then goes where its path says.
 */
export function mediaRoute(registry: MediaRegistry, method: string, pathname: string): MediaRoute | null {
  if (!pathname.startsWith("/v1/")) return null;
  const rest = pathname.slice("/v1/".length);
  for (const route of MEDIA_ROUTES) {
    const match = route.method === method && registry[route.kind] !== undefined ? route.path.exec(rest) : null;
    if (match === null) continue;
    return { kind: route.kind, model: route.model, video: route.video?.(match[1] ?? "") ?? null };
  }
  return null;
}

/** The most of a music or video create's body the gateway reads to find its model: two keyframes fit (Gufo's own limit). */
export const MEDIA_BODY_BYTES = 64 * 1024 * 1024;

/** A request the gateway refuses before it reaches the AI server. */
export class MediaRequestError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/**
 * The model a music or video create goes to, and the body to send: the one it names, which must be one of its kind's
 * in the registry, or else its fast model's, written into a JSON body. A multipart body (a video's keyframes as files)
 * is read for its `model` field and sent as it came.
 */
export function bodyModel(registry: MediaRegistry, kind: MediaRoute["kind"], contentType: string | undefined, body: Buffer): { model: string; body: Buffer } {
  const known = mediaModelIds(registry, kind);
  const fallback = MEDIA_TIERS.map((tier) => mediaModel(registry, kind, tier)).find((entry) => entry !== null)?.model;
  if (fallback === undefined) throw new MediaRequestError(404, "not_found", `This AI server makes no ${kind}.`);
  const check = (model: unknown): string => {
    if (model === undefined || model === null || model === "") return fallback;
    if (typeof model === "string" && known.includes(model)) return model;
    throw new MediaRequestError(400, "invalid_request_error", `The ${kind} models are ${known.join(" and ")}: ${JSON.stringify(model)} is neither.`);
  };
  if (/^multipart\/form-data/i.test(contentType ?? "")) {
    const named = formField("model", "[^\\r\\n]{0,200}").exec(body.subarray(0, 256 * 1024).toString("latin1"))?.[1];
    return { model: check(named), body };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new MediaRequestError(400, "invalid_request_error", "The request body must be JSON or multipart form data.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new MediaRequestError(400, "invalid_request_error", "The request body must be a JSON object.");
  const request = parsed as Record<string, unknown>;
  const model = check(request.model);
  return { model, body: request.model === model ? body : Buffer.from(JSON.stringify({ ...request, model })) };
}
