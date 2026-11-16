// Client for portal-hostd (hostd/), the small service on each server that reports live hardware
// readings and, on the LLM server, updates the LLM engine. Its API and payloads are described in
// hostd/README.md; the shapes below are what the gateway relies on and passes to the admin console.
import http from "node:http";
import https from "node:https";
import type { HostdConfig } from "./config.ts";

const REQUEST_TIMEOUT_MS = 5_000;
/** No event for this long means the stream is dead (hostd sends a sample every 0.25-5 s). */
const STREAM_IDLE_MS = 15_000;
/** A larger event is refused (a sample is about 2 KB). */
const MAX_EVENT_BYTES = 256 * 1024;

export interface HostInfo {
  hostd: number;
  hostname: string;
  role: "portal" | "llm";
  os: string;
  kernel: string;
  intervalMs: number;
  cpu: { model: string; cores: number; threads: number; maxMhz: number | null };
  gpu: { name: string; maxMhz: number | null } | null;
  memory: { totalBytes: number };
  sources: { perf: boolean; bandwidth: string | null; power: string | null; gpuBusy: string | null };
  power: { label: string } | null;
  engine: { unit: string } | null;
}

export interface HostSample {
  /** Epoch ms on the host. */
  t: number;
  cpu: { usage: number | null; mhz: number | null; mhzPeak: number | null; tempC: number | null; powerW: number | null; coreUsage: number[]; coreMhz: Array<number | null> };
  gpu: { usage: number | null; mhz: number | null; tempC: number | null; powerW: number | null; memUsedBytes: number | null; memTotalBytes: number | null } | null;
  memory: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    gpuBytes: number | null;
    swapTotalBytes: number;
    swapUsedBytes: number;
    readBps: number | null;
    writeBps: number | null;
  };
  power: { watts: number | null; parts: { gpu: number | null; cpu: number | null; dram: number | null } };
  fans: Array<{ label: string; rpm: number | null; duty: number | null }>;
  throttling?: boolean | null;
}

export interface EngineImage {
  id: string;
  digest: string | null;
  version: string | null;
  revision: string | null;
  createdAt: number | null;
  sizeBytes: number | null;
  current: boolean;
  previous: boolean;
}

export type EngineJobKind = "pull" | "apply" | "rollback";
export type EngineJobPhase = "running" | "succeeded" | "failed" | "cancelled";

export interface EngineJob {
  id: string;
  kind: EngineJobKind;
  image: string | null;
  version: string | null;
  phase: EngineJobPhase;
  step: string;
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  rolledBack: boolean;
}

export interface EngineStatus {
  unit: string;
  quadlet: string;
  repository: string;
  /** The quadlet's Image= value. */
  image: string;
  digest: string | null;
  version: string | null;
  revision: string | null;
  state: string;
  subState: string;
  ready: boolean;
  buildInfo: string | null;
  previous: { image: string; digest: string | null; version: string | null } | null;
  images: EngineImage[];
  job: EngineJob | null;
}

/** hostd answered with an error (`{ error, message }`), or not at all. */
export class HostdError extends Error {
  /** HTTP status, or null when hostd could not be reached. */
  readonly status: number | null;
  readonly code: string;

  constructor(status: number | null, code: string, message: string) {
    super(message);
    this.name = "HostdError";
    this.status = status;
    this.code = code;
  }
}

export interface StreamHandlers {
  info(info: HostInfo): void;
  sample(sample: HostSample): void;
}

export class HostdClient {
  readonly url: string;
  readonly #token: string;

  constructor(config: HostdConfig) {
    this.url = config.url;
    this.#token = config.token;
  }

  get<T>(path: string): Promise<T> {
    return this.#request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.#request<T>("POST", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.#request<T>("DELETE", path);
  }

  /**
   * Follows GET /v1/stream until `signal` aborts or the stream ends; resolves then, rejects with a
   * HostdError when it can't be opened or breaks.
   */
  stream(handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve();
      const url = this.#url("/v1/stream");
      const req = transport(url).request(url, { method: "GET", headers: this.#headers({ accept: "text/event-stream" }), agent: false });
      let idle: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = (error: HostdError | null): void => {
        if (settled) return;
        settled = true;
        if (idle !== null) clearTimeout(idle);
        signal.removeEventListener("abort", onAbort);
        req.destroy();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => finish(null);
      const touch = (): void => {
        if (idle !== null) clearTimeout(idle);
        idle = setTimeout(() => finish(new HostdError(null, "stream_idle", `no reading from ${this.url} for ${STREAM_IDLE_MS / 1000} s`)), STREAM_IDLE_MS);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("error", (error) => finish(new HostdError(null, "unreachable", `${this.url}: ${error.message}`)));
      req.on("response", (res) => {
        if (res.statusCode !== 200) {
          readError(res).then(finish, () => finish(new HostdError(res.statusCode ?? null, "bad_status", `${this.url} answered ${res.statusCode}`)));
          return;
        }
        touch();
        const parser = new SseParser((event, data) => {
          touch();
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            return;
          }
          if (typeof payload !== "object" || payload === null) return;
          if (event === "info") handlers.info(payload as HostInfo);
          else if (event === "sample" && typeof (payload as HostSample).t === "number") handlers.sample(payload as HostSample);
        });
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (!parser.push(chunk)) finish(new HostdError(200, "event_too_large", `${this.url} sent an event over ${MAX_EVENT_BYTES} bytes`));
        });
        res.on("end", () => finish(new HostdError(200, "stream_ended", `${this.url} ended the stream`)));
        res.on("error", (error) => finish(new HostdError(200, "stream_broken", `${this.url}: ${error.message}`)));
      });
      req.end();
    });
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, ...extra };
  }

  /** Under the configured URL, keeping any path it has (a hostd behind a reverse proxy's prefix). */
  #url(path: string): URL {
    return new URL(this.url.replace(/\/+$/, "") + path);
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = this.#url(path);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = this.#headers(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      const req = transport(url).request(url, { method, headers, agent: false, timeout: REQUEST_TIMEOUT_MS });
      req.on("timeout", () => req.destroy(new Error(`no answer within ${REQUEST_TIMEOUT_MS / 1000} s`)));
      req.on("error", (error) => reject(new HostdError(null, "unreachable", `${this.url}: ${error.message}`)));
      req.on("response", (res) => {
        if (res.statusCode === undefined || res.statusCode >= 300) {
          readError(res).then(reject, reject);
          return;
        }
        readBody(res).then((text) => {
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new HostdError(res.statusCode ?? null, "bad_answer", `${this.url} sent something other than JSON`));
          }
        }, reject);
      });
      req.end(payload);
    });
  }
}

/** Splits a server-sent event stream into (event, data) pairs. */
export class SseParser {
  readonly #onEvent: (event: string, data: string) => void;
  #buffer = "";
  #event = "message";
  #data: string[] = [];

  constructor(onEvent: (event: string, data: string) => void) {
    this.#onEvent = onEvent;
  }

  /** Feeds text; false when one event grew too large (the stream should be dropped). */
  push(text: string): boolean {
    this.#buffer += text;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#line(line);
    }
    return this.#buffer.length + this.#data.reduce((sum, part) => sum + part.length, 0) <= MAX_EVENT_BYTES;
  }

  #line(line: string): void {
    if (line === "") {
      if (this.#data.length > 0) this.#onEvent(this.#event, this.#data.join("\n"));
      this.#event = "message";
      this.#data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
  }
}

function transport(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

async function readBody(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_EVENT_BYTES) throw new HostdError(res.statusCode ?? null, "answer_too_large", "portal-hostd sent too large an answer");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readError(res: http.IncomingMessage): Promise<HostdError> {
  const status = res.statusCode ?? null;
  const text = await readBody(res).catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") return new HostdError(status, body.error, typeof body.message === "string" ? body.message : body.error);
  } catch {
    // not JSON
  }
  return new HostdError(status, status === 401 ? "unauthorized" : "bad_status", status === 401 ? "portal-hostd refused the token" : `portal-hostd answered ${status}`);
}
