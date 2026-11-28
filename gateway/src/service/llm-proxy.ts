// One request to the AI server and its answer back, for the workspaces (service-api.ts) and for API keys
// (llm-api.ts). A generation waits for its turn (llm-queue.ts), is followed while it runs (llm-requests.ts) and is
// counted for its user (llm_usage); any other request is passed straight on. A media model's request goes to that
// model (media-routes.ts), and a video job holds the queue until it ends (video-jobs.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform, type TransformCallback } from "node:stream";
import type { PortalDb } from "@portal/core";
import type { Config } from "../config.ts";
import { forward, type ForwardResult } from "../lib/forward.ts";
import { sendJson } from "../lib/http-util.ts";
import type { Logger } from "../lib/log.ts";
import { IMAGE_PATH, imageAsk, namedModel } from "../monitor/image-requests.ts";
import type { LlmRequests } from "../monitor/llm-requests.ts";
import { recordUsage, usageParserFor, usageTap, type UsageParser } from "../monitor/usage.ts";
import { endToEndHeaders, llmRequestHeaders } from "../proxy/headers.ts";
import type { LlmQueue, ReleaseSlot } from "./llm-queue.ts";
import { mediaModelIds } from "@portal/harnesses";
import { MEDIA_BODY_BYTES, MediaRequestError, bodyModel, checkRouteModel, mediaRoute, modelPrefix } from "./media-routes.ts";
import type { VideoJobs } from "./video-jobs.ts";

export interface LlmProxyDeps {
  config: Config;
  db: PortalDb;
  llm: LlmQueue;
  requests: LlmRequests;
  videoJobs: VideoJobs;
  log: Logger;
}

interface LlmCall {
  /** Whose request it is, and the API key it came with (null from a workspace). null: no one's, a browser's preflight. */
  caller: { userId: number; keyId: number | null } | null;
  /** On the AI server: "/v1/chat/completions". */
  pathname: string;
  /** "?…", or "". */
  search: string;
  /** Sees every chunk of the request body on its way. It must not throw. */
  observeBody?: (chunk: Buffer) => void;
}

/** The answer to a video create is a small JSON object: no more of it is kept to read its id. */
const CREATE_ANSWER_BYTES = 64 * 1024;

/** POST routes that count or format a prompt: they take none of the engine's sessions, so they are no generations. */
const NOT_A_GENERATION = /\/(?:input_tokens|count_tokens|tokenize|apply-template)$/;

/** The error shape OpenAI clients understand (the AI server's own errors pass through as they are). */
export function sendLlmError(res: ServerResponse, status: number, type: string, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { error: { message, type } }, headers);
}

/**
 * No dot segments, escapes, doubled slashes or backslashes: the AI server decodes a path and folds its slashes before
 * it routes it, so it must only ever see the path that was checked. None of its routes needs them.
 */
export function isPlainPath(pathname: string): boolean {
  return !/%|\/\/|\\/.test(pathname) && new URL(pathname, "http://localhost").pathname === pathname;
}

export async function proxyLlm(deps: LlmProxyDeps, req: IncomingMessage, res: ServerResponse, { caller, pathname, search, observeBody }: LlmCall): Promise<void> {
  const method = req.method ?? "GET";
  const { media: registry, mediaModelPath } = deps.config.llm;
  const media = caller === null ? null : mediaRoute(registry, method, pathname);
  const video = media?.video ?? null;
  // A job is its user's alone: another's is no job of theirs. A preflight (no caller) matches no media route.
  if (video !== null && video.op !== "create" && (caller === null || !deps.videoJobs.owns(caller.userId, video.id))) {
    return sendLlmError(res, 404, "not_found", "No such video job.");
  }
  let model: string | null = video !== null && video.op !== "create" ? deps.videoJobs.modelOf(video.id) : null;
  // The body is read before anything waits: Node stops reading a socket whose body nobody takes, and then never
  // learns that a client waiting in the queue hung up.
  let body: Buffer;
  const contentType = req.headers["content-type"];
  // The model the body names, on the routes that do not go by bodyModel's.
  let named: string | null = null;
  try {
    body = await readBody(req, MEDIA_BODY_BYTES, observeBody);
    // Music and a video's create go to their model's own routes: its id is read from the body.
    if (media?.model === "body") ({ model, body } = bodyModel(registry, media.kind, contentType, body));
    else if (caller !== null && method === "POST") {
      named = namedModel(contentType, body);
      checkRouteModel(registry, pathname, media, named);
    }
  } catch (error) {
    // A body over the limit is not read to its end: the answer closes the connection.
    if (error instanceof MediaRequestError) return sendLlmError(res, error.status, error.type, error.message, error.status === 413 ? { connection: "close" } : undefined);
    if (req.socket.destroyed) return;
    return sendLlmError(res, 400, "invalid_request_error", "The request body could not be read.");
  }
  const upstreamPath = model !== null && media?.model !== "root" ? `${modelPrefix(mediaModelPath, model)}${pathname}` : pathname;
  // Only a generation waits for a slot: listing the models or counting a prompt's tokens never queues behind one.
  const generating = method === "POST" && !NOT_A_GENERATION.test(pathname) ? caller : null;
  const image = generating !== null && IMAGE_PATH.test(pathname);
  const progress = generating ? deps.requests.begin(generating.userId, generating.keyId, image, media && { kind: media.kind, model }) : null;
  // The image or media model the request is for: its turn in the queue goes by it.
  let asked = model;
  if (progress && image) {
    const ask = imageAsk(contentType, deps.config.llm.imageModels, body, named);
    progress.imageAsk(ask);
    asked = ask.model;
  } else if (progress && media?.model === "root") {
    asked = named !== null && mediaModelIds(registry, media.kind).includes(named) ? named : null;
    if (asked !== null) progress.mediaModel(asked);
  }

  let release: ReleaseSlot = () => undefined;
  // A video job's create has the AI server to itself, and holds the queue from its grant until the job ends.
  let unhold: ReleaseSlot | null = null;
  // Asking about a job that has ended loads its video model again (the server keeps its video until --ttl): such a
  // request waits its turn and has the AI server to itself while it runs, as a create does.
  const late = video !== null && video.op !== "create" && !deps.videoJobs.holds(video.id) ? caller : null;
  const waits = generating ?? late;
  if (waits) {
    const hangUp = new AbortController();
    const onClose = (): void => hangUp.abort();
    res.once("close", onClose);
    try {
      if (video?.op === "create" || late) ({ release, unhold } = await deps.llm.acquireAlone(waits.userId, model, hangUp.signal));
      else release = await deps.llm.acquire(waits.userId, asked, hangUp.signal);
    } catch {
      progress?.finish("aborted");
      return; // the client hung up while queued
    } finally {
      res.off("close", onClose);
    }
    if (req.socket.destroyed) {
      release();
      unhold?.();
      progress?.finish("aborted");
      return;
    }
    progress?.forwarded();
  }

  // The queue grants nothing new until the job ends: the video model must not be stopped for another before then.
  const job = generating && unhold && model !== null ? deps.videoJobs.creating(generating.userId, model, unhold) : null;
  if (unhold && job === null && late === null) unhold();
  const answer: Buffer[] = [];
  const started = Date.now();
  const tapped: { parser: UsageParser | null } = { parser: null };
  const headers = llmRequestHeaders(req.headers, deps.config.llm.apiKey);
  // A body that came chunked, or was written anew, goes on with its length: the engine reads no chunked bodies.
  if (body.length > 0) headers["content-length"] = String(body.length);
  let result: ForwardResult | null = null;
  try {
    result = await forward(req, res, {
      url: new URL(`${deps.config.llm.upstreamUrl}${upstreamPath}${search}`),
      method,
      headers,
      body,
      responseHeaders: (incoming) => endToEndHeaders(incoming.headers),
      tap: (incoming) => {
        if (job) return copyTap(answer, CREATE_ANSWER_BYTES);
        tapped.parser = generating ? usageParserFor(incoming.headers, progress) : null;
        return tapped.parser ? usageTap(tapped.parser) : null;
      },
      onError: (error, response) => {
        deps.log.warn("AI server did not answer", { ...caller, error });
        sendLlmError(response, 502, "llm_unreachable", "The AI server is not reachable.");
      },
    });
  } finally {
    const succeeded = result !== null && result.status !== null && result.status >= 200 && result.status < 300 && result.outcome === "completed";
    if (job) {
      const created = succeeded ? jobId(answer) : null;
      if (created !== null) job.created(created);
      else job.failed();
    } else if (succeeded && (video?.op === "content" || video?.op === "cancel")) {
      deps.videoJobs.done(video.id, video.op === "content" ? "downloaded" : "cancelled");
    }
    if (late) unhold?.();
    release();
    const failed = result === null || result.outcome === "failed" || (result.status !== null && (result.status < 200 || result.status >= 300));
    progress?.finish(failed ? "failed" : succeeded ? "completed" : "aborted", tapped.parser?.usage ?? null);
  }

  const usage = tapped.parser?.usage ?? null;
  if (generating && result.status !== null && result.status >= 200 && result.status < 300) {
    try {
      recordUsage(deps.db, generating.userId, usage);
    } catch (error) {
      deps.log.error("could not record LLM usage", { ...caller, error });
    }
  }
  deps.log.info("llm request", {
    ...caller,
    method,
    path: pathname,
    status: result.status,
    outcome: result.outcome,
    ms: Date.now() - started,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
  });
}

/** The request's whole body, each chunk shown to `observe` as it comes; more than `limit` bytes is a MediaRequestError (413). */
function readBody(req: IncomingMessage, limit: number, observe?: (chunk: Buffer) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      observe?.(chunk);
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume();
        reject(new MediaRequestError(413, "payload_too_large", `The request body is larger than ${limit / 1024 / 1024} MiB.`));
      } else chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
    req.once("close", () => reject(new Error("the client hung up")));
  });
}

/** Passes the body on and keeps a copy of its first `limit` bytes in `chunks`. */
function copyTap(chunks: Buffer[], limit: number): Transform {
  let kept = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      if (kept < limit) chunks.push(chunk.subarray(0, limit - kept));
      kept += chunk.length;
      callback(null, chunk);
    },
  });
}

/** The `id` of a created video job, from the server's answer; null when it holds none. */
function jobId(answer: readonly Buffer[]): string | null {
  try {
    const id: unknown = (JSON.parse(Buffer.concat(answer).toString("utf8")) as { id?: unknown } | null)?.id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}
