// Each LLM request's share of the LLM server's measured energy, for its workspace session (session-log.ts) or its
// API key (key-usage.ts). While requests run, the LLM server's portal-hostd meter (GET /v1/meter, brought up to date
// every 2 s) is read every READ_MS; the energy each reading adds is shared among the requests that ran in that
// stretch, by how long each ran in it, and each owner also gets the time it had a request running (its parallel ones
// count once, so its energy over that time is its average draw). Nothing is read while the LLM server has no
// request, so its idle draw goes to no one. Each stretch is bounded by the meter's own times (the LLM server's
// clock), unless that clock is off by more than CLOCK_SKEW_MS; a request keeps its place until a reading covers its
// end.
import { isMeterReading, type MeterSource } from "./energy-meter.ts";
import type { Logger } from "../lib/log.ts";
import { singleFlight } from "../lib/single-flight.ts";

const READ_MS = 2_000;
const CLOCK_SKEW_MS = 5_000;

/** Whose a request's share is: its workspace session's, or its API key's. */
export type EnergyOwner = { sessionId: number } | { keyId: number };
/** Energy an owner's requests used in one stretch of time, and how long it had a request running in it (parallel ones count once). */
export type EnergyShare = EnergyOwner & { joules: number; ms: number };

export interface LlmEnergyOptions {
  /** The LLM server's portal-hostd; null when it isn't set up (then nothing is measured). */
  source: MeterSource | null;
  /** Each reading's shares, per owner. Must not throw. */
  onShares: (shares: EnergyShare[]) => void;
  log: Logger;
  now?: () => number;
  readMs?: number;
}

interface Tracked {
  owner: EnergyOwner;
  from: number;
  /** When it ended; null while it runs. */
  to: number | null;
}

export class LlmEnergy {
  readonly #source: MeterSource | null;
  readonly #onShares: (shares: EnergyShare[]) => void;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #readMs: number;
  readonly #requests = new Map<number, Tracked>();
  /** The last reading of this busy spell: the start of the next stretch. */
  #last: { instance: string; energyJ: number; t: number } | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #failing = false;
  #stopped = false;

  constructor(options: LlmEnergyOptions) {
    this.#source = options.source;
    this.#onShares = options.onShares;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#readMs = options.readMs ?? READ_MS;
  }

  /** A request of `owner` reached the LLM server at `at`. */
  started(requestId: number, owner: EnergyOwner, at: number): void {
    if (this.#source === null || this.#stopped) return;
    this.#requests.set(requestId, { owner, from: at, to: null });
    if (this.#timer !== null) return;
    void this.read();
    this.#timer = setInterval(() => void this.read(), this.#readMs);
  }

  /** It ended at `at`. */
  ended(requestId: number, at: number): void {
    const request = this.#requests.get(requestId);
    if (request) request.to = at;
  }

  /** Stops reading (gateway shutdown). */
  stop(): void {
    this.#stopped = true;
    this.#idle();
  }

  /** One reading (the timer's; exposed for tests). Readings never overlap. */
  readonly read = singleFlight(() => this.#readOnce());

  async #readOnce(): Promise<void> {
    if (this.#source === null) return;
    let reading: unknown;
    try {
      reading = await this.#source.get<unknown>("/v1/meter");
      if (!isMeterReading(reading) || !Number.isFinite(reading.t)) throw new Error("a meter reading of another shape");
      if (this.#failing) this.#log.info("LLM energy: reading the LLM server's meter again");
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#log.warn("LLM energy: cannot read the LLM server's meter", { url: this.#source.url, error });
      this.#failing = true;
      return;
    }
    if (this.#stopped) return;
    const now = this.#now();
    const t = Math.abs(reading.t - now) <= CLOCK_SKEW_MS ? reading.t : now;
    if (reading.energyJ === null) {
      // The LLM server's power can't be measured: nothing to share.
      this.#requests.clear();
      this.#idle();
      return;
    }
    const last = this.#last;
    if (last !== null && last.instance === reading.instance && reading.energyJ >= last.energyJ && t > last.t) {
      this.#share(last.t, t, reading.energyJ - last.energyJ);
    }
    if (last === null || t > last.t || last.instance !== reading.instance) this.#last = { instance: reading.instance, energyJ: reading.energyJ, t };
    for (const [id, request] of this.#requests) if (request.to !== null && request.to <= t) this.#requests.delete(id);
    if (this.#requests.size === 0) this.#idle();
  }

  /** `joules` used from `from` to `to`, shared by how long each request ran in that stretch. */
  #share(from: number, to: number, joules: number): void {
    const owners = new Map<string, { owner: EnergyOwner; span: number; intervals: Array<[number, number]> }>();
    let total = 0;
    for (const request of this.#requests.values()) {
      const start = Math.max(from, request.from);
      const end = Math.min(to, request.to ?? to);
      if (end <= start) continue;
      const key = JSON.stringify(request.owner);
      const share = owners.get(key) ?? { owner: request.owner, span: 0, intervals: [] };
      share.span += end - start;
      share.intervals.push([start, end]);
      owners.set(key, share);
      total += end - start;
    }
    if (total <= 0) return;
    this.#onShares([...owners.values()].map(({ owner, span, intervals }) => ({ ...owner, joules: (joules * span) / total, ms: coveredMs(intervals) })));
  }

  #idle(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#last = null;
  }
}

/** The time covered by at least one of the intervals. */
function coveredMs(intervals: Array<[number, number]>): number {
  let covered = 0;
  let end = -Infinity;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (stop <= end) continue;
    covered += stop - Math.max(start, end);
    end = stop;
  }
  return covered;
}
