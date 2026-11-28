// Concurrency limiter for the AI server's generations: at most `maxConcurrency` in flight and `maxPerUser` per user.
// Waiters are served first come, first served; a waiter whose user is at their own limit does not hold up other
// users queued behind it.
// The AI server has room for one of the LLM and the image and media models that are loaded in its place, and
// llama-swap serves the loaded one's requests first for as long as they keep coming. So the turns are given here: a
// request for another model than the one in use waits until that one's requests have ended, and every such request
// behind it waits with it. Requests for one model that arrive together are so made together, on one load of it.
// The models that run beside the LLM (media.json's besideLlm) wait for no turn and are counted apart, up to the same
// limits: they take no session of the LLM's.
// While paused (an engine update restarts the AI server) or held (a video job runs on the AI server), nothing new is
// granted: requests wait here instead of failing, or stopping the job. A request that needs the AI server to itself
// (acquireAlone: a video job's create) waits at its place until nothing is in flight; nothing behind it goes first,
// and the queue is held from the moment it is granted.

/** Gives the slot back. Safe to call more than once. */
export type ReleaseSlot = () => void;

interface Waiter {
  userId: number;
  since: number;
  /** The image or media model it is for; null for the LLM, and for a model media.json does not name. */
  model: string | null;
  /** acquireAlone's: granted only with nothing in flight, and with a hold. */
  alone: boolean;
  grant: (release: ReleaseSlot, unhold: ReleaseSlot | null) => void;
}

/** The requests in flight that are counted together. */
interface Lane {
  inFlight: number;
  readonly byUser: Map<number, number>;
}

export class LlmQueue {
  readonly maxConcurrency: number;
  readonly maxPerUser: number;
  readonly #besideLlm: ReadonlySet<string>;
  /** The LLM's requests, or those of the one model loaded in its place. */
  readonly #turn: Lane = { inFlight: 0, byUser: new Map() };
  /** What #turn's requests in flight are for (null: the LLM). It says nothing once they have ended. */
  #model: string | null = null;
  /** The requests of the models that run beside the LLM. */
  readonly #beside: Lane = { inFlight: 0, byUser: new Map() };
  #paused = false;
  #holds = 0;
  readonly #waiting: Waiter[] = [];

  constructor(maxConcurrency: number, maxPerUser: number, besideLlm: ReadonlySet<string> = new Set()) {
    this.maxConcurrency = maxConcurrency;
    this.maxPerUser = maxPerUser;
    this.#besideLlm = besideLlm;
  }

  get inFlight(): number {
    return this.#turn.inFlight + this.#beside.inFlight;
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
    return (this.#turn.byUser.get(userId) ?? 0) + (this.#beside.byUser.get(userId) ?? 0);
  }

  /** In flight plus queued: while this is non-zero the workspace is busy, never idle. */
  pendingFor(userId: number): number {
    let queued = 0;
    for (const waiter of this.#waiting) if (waiter.userId === userId) queued++;
    return this.inFlightFor(userId) + queued;
  }

  /**
   * Resolves with a release function once the request may go; rejects if `signal` aborts first. `model` is the image
   * or media model it is for: null for the LLM, and for a model media.json does not name.
   */
  async acquire(userId: number, model: string | null = null, signal?: AbortSignal): Promise<ReleaseSlot> {
    return (await this.#enqueue(userId, model, false, signal)).release;
  }

  /**
   * Like acquire, for a request that must have the AI server to itself: it is granted once nothing is in flight,
   * nothing queued behind it is granted before it, and from its grant the queue is held as by hold() until `unhold`.
   */
  async acquireAlone(userId: number, model: string | null = null, signal?: AbortSignal): Promise<{ release: ReleaseSlot; unhold: ReleaseSlot }> {
    const { release, unhold } = await this.#enqueue(userId, model, true, signal);
    return { release, unhold: unhold! };
  }

  #enqueue(userId: number, model: string | null, alone: boolean, signal?: AbortSignal): Promise<{ release: ReleaseSlot; unhold: ReleaseSlot | null }> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(signal?.reason);
        // What waited behind it may go now.
        this.#dispatch();
      };
      const waiter: Waiter = {
        userId,
        since: Date.now(),
        model,
        alone,
        grant: (release, unhold) => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ release, unhold });
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(waiter);
      this.#dispatch();
    });
  }

  #dispatch(): void {
    if (this.#paused || this.#holds > 0) return;
    // A request ahead waits for its model's turn: those behind it that need a turn wait with it.
    let turnTaken = false;
    for (let i = 0; i < this.#waiting.length; ) {
      const waiter = this.#waiting[i]!;
      if (waiter.alone) {
        // Nothing behind it goes first; it goes once what is in flight has ended.
        if (this.inFlight > 0) return;
        this.#waiting.splice(i, 1);
        const unhold = this.hold();
        this.#model = waiter.model;
        waiter.grant(this.#take(this.#turn, waiter.userId), unhold);
        return;
      }
      const beside = waiter.model !== null && this.#besideLlm.has(waiter.model);
      const lane = beside ? this.#beside : this.#turn;
      if (!beside) turnTaken ||= lane.inFlight > 0 && waiter.model !== this.#model;
      if ((!beside && turnTaken) || lane.inFlight >= this.maxConcurrency || (lane.byUser.get(waiter.userId) ?? 0) >= this.maxPerUser) {
        i++;
        continue;
      }
      this.#waiting.splice(i, 1);
      if (!beside) this.#model = waiter.model;
      waiter.grant(this.#take(lane, waiter.userId), null);
    }
  }

  #take(lane: Lane, userId: number): ReleaseSlot {
    lane.inFlight++;
    lane.byUser.set(userId, (lane.byUser.get(userId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.inFlight--;
      const remaining = (lane.byUser.get(userId) ?? 0) - 1;
      if (remaining > 0) lane.byUser.set(userId, remaining);
      else lane.byUser.delete(userId);
      this.#dispatch();
    };
  }
}
