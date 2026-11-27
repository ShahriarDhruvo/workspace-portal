// The LLM generation requests passing through the gateway: whose request it is, when it was queued and forwarded,
// when its first token came back, how many tokens have streamed so far, and once it ends the engine's own timings
// and the answer's usage. The proxy (service-api.ts) reports into it; llm-monitor.ts reads the requests in flight
// for the admin's live view, and a listener hears each one reach the AI server and end (main.ts: the workspace
// sessions and their energy). Cheap enough to run always: the response stream is read for usage anyway
// (usage.ts), and this adds a counter per event.
import type { GenerationKind } from "@portal/core";
import { generationPace, type GenerationPace, type ImageAsk } from "./image-requests.ts";
import type { EngineTimings, StreamObserver, TokenUsage } from "./usage.ts";

export interface ActiveLlmRequest {
  readonly id: number;
  readonly userId: number;
  readonly queuedAt: number;
  /** When the gateway sent it to the AI server; null while it waits for a slot in the gateway. */
  forwardedAt: number | null;
  /** When the first generated token arrived; null while the engine is still reading the prompt. */
  firstTokenAt: number | null;
  /** Generated tokens streamed back so far (one per output event). */
  tokens: number;
  /** What an image request asks for (image-requests.ts); null for the LLM. */
  image: ImageAsk | null;
  /** The media model a media request is for (media-routes.ts); null for the LLM and the image models. */
  media: MediaWork | null;
}

export interface MediaWork {
  kind: Exclude<GenerationKind, "image">;
  /** The model it names; null until its body has said (speech and transcription go to the server's own routes). */
  model: string | null;
}

/** A request that reached the AI server, once it has ended. */
export interface FinishedLlmRequest {
  id: number;
  userId: number;
  /** The API key it came with; null from a workspace. */
  keyId: number | null;
  forwardedAt: number;
  finishedAt: number;
  /** From being forwarded to the last byte. */
  durationMs: number;
  /** Time spent waiting for a slot in the gateway. */
  queueMs: number;
  /** From being forwarded to the first token; null when none came. */
  ttftMs: number | null;
  /** The engine's account; null when it sent none (an error, a non-streaming reply, another engine). */
  timings: EngineTimings | null;
  /** The answer's `usage`, or of a stream without one what the engine's timings count; null without either. */
  usage: TokenUsage | null;
  /** False when the AI server failed it: an answer that is not 2xx, or none, or a stream that broke. */
  ok: boolean;
}

/** Hears the requests that reach the AI server. Its methods must not throw. */
export interface LlmRequestListener {
  forwarded(request: { id: number; userId: number; keyId: number | null; forwardedAt: number }): void;
  finished(request: FinishedLlmRequest): void;
}

/** What the proxy reports for one request. Every method is safe to call in any order, and more than once. */
export interface LlmRequestHandle extends StreamObserver {
  forwarded(): void;
  /** What an image request asks for, as its body is read. */
  imageAsk(ask: ImageAsk): void;
  /** The model a media request names, as its body is read. */
  mediaModel(model: string): void;
  /** How it ended; `usage`: the answer's, when it had one. */
  finish(end: RequestEnd, usage?: TokenUsage | null): void;
}

/**
 * completed: answered in full with a 2xx; aborted: the client hung up first (a cancelled turn, a workspace's stop),
 * which is not the AI server failing; failed: any other answer, none, or a stream that broke.
 */
export type RequestEnd = "completed" | "aborted" | "failed";

export class LlmRequests {
  readonly #now: () => number;
  readonly #listener: LlmRequestListener | null;
  readonly #active = new Map<number, ActiveLlmRequest>();
  #nextId = 1;
  /**
   * When the LLM ("") and each image and media model last finished a request. Behind llama-swap a model makes one
   * thing at a time, and one that swaps with the LLM never starts while the LLM has requests: so a request's own time
   * starts when it was forwarded, or when the request before it on its model (or on the LLM, for a model that swaps
   * with it) finished, whichever is latest.
   */
  readonly #lastFinished = new Map<string, number>();
  readonly #paces: GenerationPace[] = [];
  /** The models that run beside the LLM (media.json's besideLlm): the LLM's requests don't hold them up. */
  readonly #besideLlm: ReadonlySet<string>;
  #lastGeneration: { kind: GenerationKind; at: number } | null = null;

  constructor(options: { now?: () => number; listener?: LlmRequestListener; besideLlm?: ReadonlySet<string> } = {}) {
    this.#now = options.now ?? Date.now;
    this.#listener = options.listener ?? null;
    this.#besideLlm = options.besideLlm ?? new Set();
  }

  /** A generation request arrived (it may still wait for a slot), from a workspace or with an API key. */
  begin(userId: number, keyId: number | null = null, image = false, media: MediaWork | null = null): LlmRequestHandle {
    const entry: ActiveLlmRequest = {
      id: this.#nextId++,
      userId,
      queuedAt: this.#now(),
      forwardedAt: null,
      firstTokenAt: null,
      tokens: 0,
      image: image ? { model: null, images: 1 } : null,
      media,
    };
    this.#active.set(entry.id, entry);
    let timings: EngineTimings | null = null;
    let done = false;
    return {
      forwarded: () => {
        if (done || entry.forwardedAt !== null) return;
        entry.forwardedAt = this.#now();
        this.#listener?.forwarded({ id: entry.id, userId, keyId, forwardedAt: entry.forwardedAt });
      },
      imageAsk: (ask) => {
        if (!done && entry.image !== null) entry.image = ask;
      },
      mediaModel: (model) => {
        if (!done && entry.media !== null) entry.media = { ...entry.media, model };
      },
      token: () => {
        if (done) return;
        if (entry.firstTokenAt === null) entry.firstTokenAt = this.#now();
        entry.tokens++;
      },
      timings: (value) => {
        timings = value;
      },
      finish: (end, usage = null) => {
        if (done) return;
        done = true;
        this.#active.delete(entry.id);
        // A request that never reached the AI server (the workspace hung up while queued) is no request.
        if (entry.forwardedAt === null) return;
        const finishedAt = this.#now();
        this.#time(entry, finishedAt, end);
        this.#listener?.finished({
          id: entry.id,
          userId,
          keyId,
          forwardedAt: entry.forwardedAt,
          finishedAt,
          durationMs: finishedAt - entry.forwardedAt,
          queueMs: entry.forwardedAt - entry.queuedAt,
          ttftMs: entry.firstTokenAt === null ? null : entry.firstTokenAt - entry.forwardedAt,
          timings,
          usage,
          ok: end !== "failed",
        });
      },
    };
  }

  /** Requests queued or running, oldest first. */
  active(): ActiveLlmRequest[] {
    return [...this.#active.values()];
  }

  /**
   * The median time of `kind`'s last five on the model of its kind that finished one last (LlmGeneration.pace): per
   * image for images, per request for the others; null before any. A video's request only creates its job: its
   * pace is the job's (VideoJobs.pace).
   */
  pace(kind: GenerationKind): { model: string | null; seconds: number } | null {
    return generationPace(this.#paces, kind);
  }

  /** The kind of the generation that finished last, and when; null before any. */
  lastGeneration(): { kind: GenerationKind; at: number } | null {
    return this.#lastGeneration;
  }

  #time(entry: ActiveLlmRequest, finishedAt: number, end: RequestEnd): void {
    const kind: GenerationKind | null = entry.image !== null ? "image" : (entry.media?.kind ?? null);
    const model = entry.image?.model ?? entry.media?.model ?? null;
    const key = kind === null ? "" : `${kind}:${model ?? ""}`;
    if (kind !== null && kind !== "video" && end === "completed") {
      const beside = model !== null && this.#besideLlm.has(model);
      const start = Math.max(entry.forwardedAt!, beside ? 0 : (this.#lastFinished.get("") ?? 0), this.#lastFinished.get(key) ?? 0);
      this.#paces.push({ kind, model, seconds: (finishedAt - start) / 1000 / (entry.image?.images ?? 1) });
      if (this.#paces.length > 50) this.#paces.shift();
      this.#lastGeneration = { kind, at: finishedAt };
    }
    // An LLM request that ends before its first token without an answer may have waited out a swap: it held no LLM.
    if (kind !== null || end === "completed" || entry.firstTokenAt !== null) this.#lastFinished.set(key, finishedAt);
  }
}
