// Live hardware readings of one server, from its portal-hostd's event stream. Connected only while
// someone watches (the admin's Overview), so hostd samples nothing the rest of the time. Keeps the last
// minute of readings for the charts a new viewer opens with.
import { HostdClient, HostdError, type HostInfo, type HostSample } from "./hostd.ts";
import type { HostdConfig } from "./config.ts";
import type { Logger } from "./log.ts";

/** Readings kept for a new viewer's charts. */
const HISTORY_MS = 60_000;
/** After the last viewer leaves, the stream stays open this long (a page reload doesn't reconnect). */
const LINGER_MS = 15_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

export type HostRole = "portal" | "llm";
/** off: not set up (no token); connecting; online: readings arrive; offline: hostd can't be reached or refused. */
export type HostState = "off" | "connecting" | "online" | "offline";

export interface HostLive {
  role: HostRole;
  state: HostState;
  /** Why it is offline. */
  error: string | null;
  info: HostInfo | null;
  sample: HostSample | null;
}

export class HostMonitor {
  readonly role: HostRole;
  readonly #client: HostdClient | null;
  readonly #log: Logger;
  #viewers = 0;
  #linger: ReturnType<typeof setTimeout> | null = null;
  #abort: AbortController | null = null;
  #state: HostState;
  #error: string | null = null;
  #info: HostInfo | null = null;
  #history: HostSample[] = [];

  constructor(options: { role: HostRole; config: HostdConfig; log: Logger }) {
    this.role = options.role;
    this.#client = options.config.token === "" ? null : new HostdClient(options.config);
    this.#log = options.log;
    this.#state = this.#client === null ? "off" : "connecting";
  }

  /** A viewer arrived; the returned function says it left. Connects on the first viewer. */
  watch(): () => void {
    this.#viewers++;
    if (this.#linger !== null) {
      clearTimeout(this.#linger);
      this.#linger = null;
    }
    if (this.#abort === null && this.#client !== null) this.#connect(this.#client);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#viewers--;
      if (this.#viewers === 0 && this.#abort !== null) this.#linger = setTimeout(() => this.#disconnect(), LINGER_MS);
    };
  }

  live(): HostLive {
    return { role: this.role, state: this.#state, error: this.#error, info: this.#info, sample: this.#history.at(-1) ?? null };
  }

  /** The last minute of readings, oldest first. */
  history(): HostSample[] {
    return [...this.#history];
  }

  /** Closes the stream now (gateway shutdown). */
  close(): void {
    if (this.#linger !== null) clearTimeout(this.#linger);
    this.#linger = null;
    this.#disconnect();
  }

  #connect(client: HostdClient): void {
    const abort = new AbortController();
    this.#abort = abort;
    void this.#follow(client, abort.signal);
  }

  #disconnect(): void {
    this.#linger = null;
    this.#abort?.abort();
    this.#abort = null;
    this.#history = [];
    if (this.#state !== "off") this.#state = "connecting";
  }

  /** Follows the stream, reconnecting with backoff, until disconnected. */
  async #follow(client: HostdClient, signal: AbortSignal): Promise<void> {
    let retryMs = RETRY_MIN_MS;
    while (!signal.aborted) {
      try {
        await client.stream(
          {
            info: (info) => {
              this.#info = info;
            },
            sample: (sample) => {
              if (this.#state !== "online") this.#log.info("server readings: connected", { role: this.role, url: client.url });
              this.#state = "online";
              this.#error = null;
              retryMs = RETRY_MIN_MS;
              const last = this.#history.at(-1);
              if (last && sample.t <= last.t) return;
              this.#history.push(sample);
              while (this.#history.length > 0 && this.#history[0]!.t < sample.t - HISTORY_MS) this.#history.shift();
            },
          },
          signal,
        );
      } catch (error) {
        const message = error instanceof HostdError ? error.message : String(error);
        if (this.#state !== "offline" || this.#error !== message) this.#log.warn("server readings: portal-hostd unavailable", { role: this.role, url: client.url, error: message });
        this.#state = "offline";
        this.#error = message;
        this.#history = [];
      }
      if (signal.aborted) return;
      await sleep(retryMs, signal);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
