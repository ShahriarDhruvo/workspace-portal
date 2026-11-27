// Concurrency limiter for LLM requests: at most `maxConcurrency` in flight overall and
// `maxPerUser` per user. Waiters are served first come, first served; a waiter whose user is at
// their own limit does not hold up other users queued behind it. While paused (an engine update
// restarts the AI server) or held (a video job runs on the AI server), nothing new is granted:
// requests wait here instead of failing, or stopping the job.

/** Gives the slot back. Safe to call more than once. */
export type ReleaseSlot = () => void;

interface Waiter {
  userId: number;
  since: number;
  grant: (release: ReleaseSlot) => void;
}

export class LlmQueue {
  readonly maxConcurrency: number;
  readonly maxPerUser: number;
  #inFlight = 0;
  #paused = false;
  #holds = 0;
  readonly #inFlightByUser = new Map<number, number>();
  readonly #waiting: Waiter[] = [];

  constructor(maxConcurrency: number, maxPerUser: number) {
    this.maxConcurrency = maxConcurrency;
    this.maxPerUser = maxPerUser;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Holds every new request in the queue until resume(); requests in flight carry on. */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#dispatch();
  }

  /** At least one hold() is in place. */
  get held(): boolean {
    return this.#holds > 0;
  }

  /**
   * Grants nothing new until the returned function is called, like pause() but one per holder, so an engine update's
   * resume() does not end it. Requests in flight carry on.
   */
  hold(): ReleaseSlot {
    this.#holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holds--;
      this.#dispatch();
    };
  }

  /** Who waits, and since when (epoch ms), in queue order. */
  waiting(): Array<{ userId: number; since: number }> {
    return this.#waiting.map(({ userId, since }) => ({ userId, since }));
  }

  inFlightFor(userId: number): number {
    return this.#inFlightByUser.get(userId) ?? 0;
  }

  /** In flight plus queued: while this is non-zero the workspace is busy, never idle. */
  pendingFor(userId: number): number {
    let queued = 0;
    for (const waiter of this.#waiting) if (waiter.userId === userId) queued++;
    return this.inFlightFor(userId) + queued;
  }

  /** Resolves with a release function once a slot is free; rejects if `signal` aborts first. */
  acquire(userId: number, signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        userId,
        since: Date.now(),
        grant: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(waiter);
      this.#dispatch();
    });
  }

  #dispatch(): void {
    if (this.#paused || this.#holds > 0) return;
    for (let i = 0; i < this.#waiting.length && this.#inFlight < this.maxConcurrency; ) {
      const waiter = this.#waiting[i]!;
      if (this.inFlightFor(waiter.userId) >= this.maxPerUser) {
        i++;
        continue;
      }
      this.#waiting.splice(i, 1);
      waiter.grant(this.#take(waiter.userId));
    }
  }

  #take(userId: number): ReleaseSlot {
    this.#inFlight++;
    this.#inFlightByUser.set(userId, this.inFlightFor(userId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight--;
      const remaining = this.inFlightFor(userId) - 1;
      if (remaining > 0) this.#inFlightByUser.set(userId, remaining);
      else this.#inFlightByUser.delete(userId);
      this.#dispatch();
    };
  }
}
