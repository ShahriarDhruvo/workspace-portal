// The LLM generation requests passing through the gateway, for the admin's live view: whose request
// it is, when it was queued and forwarded, when its first token came back, how many tokens have
// streamed so far, and the engine's own timings once it ends. The proxy (service-api.ts) reports
// into it; llm-monitor.ts reads it. Cheap enough to run always: the response stream is read for
// usage anyway (usage.ts), and this adds a counter per event.
import type { EngineTimings, StreamObserver } from "./usage.ts";

/** How many finished requests are kept for the "recent" list. */
const RECENT_LIMIT = 20;

export interface ActiveLlmRequest {
  readonly id: number;
  readonly userId: number;
  readonly queuedAt: number;
  /** When the gateway sent it to the LLM server; null while it waits for a slot in the gateway. */
  forwardedAt: number | null;
  /** When the first generated token arrived; null while the engine is still reading the prompt. */
  firstTokenAt: number | null;
  /** Generated tokens streamed back so far (one per output event). */
  tokens: number;
}

export interface FinishedLlmRequest {
  id: number;
  userId: number;
  finishedAt: number;
  /** From being forwarded to the last byte. */
  durationMs: number;
  /** Time spent waiting for a slot in the gateway. */
  queueMs: number;
  /** From being forwarded to the first token; null when none came. */
  ttftMs: number | null;
  /** The engine's account; null when it sent none (an error, a non-streaming reply, another engine). */
  timings: EngineTimings | null;
  /** The request ended normally with a 2xx answer. */
  ok: boolean;
}

/** What the proxy reports for one request. Every method is safe to call in any order, and more than once. */
export interface LlmRequestHandle extends StreamObserver {
  forwarded(): void;
  finish(ok: boolean): void;
}

export class LlmRequests {
  readonly #now: () => number;
  readonly #active = new Map<number, ActiveLlmRequest>();
  readonly #recent: FinishedLlmRequest[] = [];
  #nextId = 1;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** A generation request arrived (it may still wait for a slot). */
  begin(userId: number): LlmRequestHandle {
    const entry: ActiveLlmRequest = { id: this.#nextId++, userId, queuedAt: this.#now(), forwardedAt: null, firstTokenAt: null, tokens: 0 };
    this.#active.set(entry.id, entry);
    let timings: EngineTimings | null = null;
    let done = false;
    return {
      forwarded: () => {
        if (!done && entry.forwardedAt === null) entry.forwardedAt = this.#now();
      },
      token: () => {
        if (done) return;
        if (entry.firstTokenAt === null) entry.firstTokenAt = this.#now();
        entry.tokens++;
      },
      timings: (value) => {
        timings = value;
      },
      finish: (ok) => {
        if (done) return;
        done = true;
        this.#active.delete(entry.id);
        // A request that never reached the LLM server (the workspace hung up while queued) is no request.
        if (entry.forwardedAt === null) return;
        const finishedAt = this.#now();
        this.#recent.unshift({
          id: entry.id,
          userId: entry.userId,
          finishedAt,
          durationMs: finishedAt - entry.forwardedAt,
          queueMs: entry.forwardedAt - entry.queuedAt,
          ttftMs: entry.firstTokenAt === null ? null : entry.firstTokenAt - entry.forwardedAt,
          timings,
          ok,
        });
        if (this.#recent.length > RECENT_LIMIT) this.#recent.length = RECENT_LIMIT;
      },
    };
  }

  /** Requests queued or running, oldest first. */
  active(): ActiveLlmRequest[] {
    return [...this.#active.values()];
  }

  /** The latest finished requests, newest first. */
  recent(): readonly FinishedLlmRequest[] {
    return this.#recent;
  }
}
