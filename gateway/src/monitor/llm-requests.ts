// The LLM generation requests passing through the gateway: whose request it is, when it was queued and forwarded,
// when its first token came back, how many tokens have streamed so far, and once it ends the engine's own timings
// and the answer's usage. The proxy (service-api.ts) reports into it; llm-monitor.ts reads the requests in flight
// for the admin's live view, and a listener hears each one reach the AI server and end (main.ts: the workspace
// sessions and their energy). Cheap enough to run always: the response stream is read for usage anyway
// (usage.ts), and this adds a counter per event.
import { imagePace, type ImageAsk } from "./image-requests.ts";
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
  /** `usage`: the answer's, when it had one. */
  finish(ok: boolean, usage?: TokenUsage | null): void;
}

export class LlmRequests {
  readonly #now: () => number;
  readonly #listener: LlmRequestListener | null;
  readonly #active = new Map<number, ActiveLlmRequest>();
  #nextId = 1;
  /**
   * When the LLM ("") and each image model last finished a request. Behind llama-swap an image model makes one image
   * at a time, and never while the LLM has requests: so an image request's own time starts when it was forwarded, or
   * when the request before it on its model or on the LLM finished, whichever is latest.
   */
  readonly #lastFinished = new Map<string, number>();
  readonly #paces: Array<{ model: string | null; secondsPerImage: number }> = [];

  constructor(options: { now?: () => number; listener?: LlmRequestListener } = {}) {
    this.#now = options.now ?? Date.now;
    this.#listener = options.listener ?? null;
  }

  /** A generation request arrived (it may still wait for a slot), from a workspace or with an API key. */
  begin(userId: number, keyId: number | null = null, image = false): LlmRequestHandle {
    const entry: ActiveLlmRequest = {
      id: this.#nextId++,
      userId,
      queuedAt: this.#now(),
      forwardedAt: null,
      firstTokenAt: null,
      tokens: 0,
      image: image ? { model: null, images: 1 } : null,
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
      token: () => {
        if (done) return;
        if (entry.firstTokenAt === null) entry.firstTokenAt = this.#now();
        entry.tokens++;
      },
      timings: (value) => {
        timings = value;
      },
      finish: (ok, usage = null) => {
        if (done) return;
        done = true;
        this.#active.delete(entry.id);
        // A request that never reached the AI server (the workspace hung up while queued) is no request.
        if (entry.forwardedAt === null) return;
        const finishedAt = this.#now();
        this.#timeImage(entry, finishedAt, ok);
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
          ok,
        });
      },
    };
  }

  /** Requests queued or running, oldest first. */
  active(): ActiveLlmRequest[] {
    return [...this.#active.values()];
  }

  /** Seconds per image of the image model that finished one last (LlmImages.pace); null before any. */
  imagePace(): { model: string | null; secondsPerImage: number } | null {
    return imagePace(this.#paces);
  }

  #timeImage(entry: ActiveLlmRequest, finishedAt: number, ok: boolean): void {
    const key = entry.image === null ? "" : `image:${entry.image.model ?? ""}`;
    if (entry.image !== null && ok) {
      const start = Math.max(entry.forwardedAt!, this.#lastFinished.get("") ?? 0, this.#lastFinished.get(key) ?? 0);
      this.#paces.push({ model: entry.image.model, secondsPerImage: (finishedAt - start) / 1000 / entry.image.images });
      if (this.#paces.length > 20) this.#paces.shift();
    }
    this.#lastFinished.set(key, finishedAt);
  }
}
