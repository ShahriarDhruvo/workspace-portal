// The live view of the LLM server for Admin > Usage: for each request it is working on, how fast it reads the
// prompt ("Read": prompt tokens processed per second) and writes the answer ("Write": generated tokens per
// second), the totals, and who is waiting. (What each workspace session added up to is session-log.ts's.)
//
// Two sources, joined:
// - The engine's own sessions, from `GET /slots` (llama.cpp's server and engines derived from it, such
//   as gufo): live prompt progress and generated-token counts per session. About 2 KB and under 2 ms
//   per call, polled every POLL_MS only while someone watches (live.ts starts and stops it).
// - The gateway's record of each request (llm-requests.ts): whose it is, its queue time, its first
//   token and, once it ends, the engine's exact timings.
// The engine doesn't say whose request a session serves. It numbers requests (id_task) in the order
// they arrive, and the gateway forwards them in order, so new sessions are paired, in task order, with
// the oldest unpaired requests that were forwarded before the session was first seen. Without /slots
// (another kind of server) the rows come from the gateway alone: Write from the streamed tokens, and
// Read only for finished requests (from their timings).
import type { LlmQueue } from "./llm-queue.ts";
import type { ActiveLlmRequest, LlmRequests } from "./llm-requests.ts";
import type { Logger } from "./log.ts";

const POLL_MS = 500;
const SLOTS_TIMEOUT_MS = 1_500;
/** Write rates are measured over this much recent history. */
const WRITE_WINDOW_MS = 3_000;
/** A rate needs at least this much history to mean anything. */
const MIN_SPAN_MS = 800;
/** A forwarded request without an engine session for this long is shown as waiting in the engine. */
const ENGINE_WAIT_GRACE_MS = 1_000;

export type EngineState = "ready" | "loading" | "offline" | "unknown";
export type SessionPhase = "preparing" | "reading" | "writing";

/** One engine session working on a request. Token counts and rates are null where unknown. */
export interface LlmSession {
  /** The engine's session number, from 1; null without /slots. */
  slot: number | null;
  userId: number | null;
  userName: string | null;
  /** preparing: admitted, nothing processed yet (prompt cache, images); reading: the prompt; writing: the answer. */
  phase: SessionPhase;
  promptTokens: number | null;
  /** Prompt tokens reused from the engine's prompt cache (not read again). */
  cachedTokens: number | null;
  /** Prompt tokens read so far. */
  processedTokens: number | null;
  generatedTokens: number;
  readTps: number | null;
  writeTps: number | null;
  /** When the request reached the engine (epoch ms). */
  startedAt: number;
}

export interface LlmWaiting {
  userId: number;
  userName: string | null;
  since: number;
  /** portal: in the gateway's queue (limits, or a paused queue); engine: forwarded, the engine has no free session. */
  stage: "portal" | "engine";
}

export interface LlmLive {
  engine: EngineState;
  /** The engine reports its sessions (/slots); otherwise rows come from the gateway alone. */
  sessionsReported: boolean;
  /** Sessions the engine has (null when unknown). */
  engineSessions: number | null;
  maxConcurrency: number;
  inFlight: number;
  queued: number;
  /** The gateway holds new requests (an engine update is restarting the LLM server). */
  paused: boolean;
  sessions: LlmSession[];
  waiting: LlmWaiting[];
  totals: { readTps: number; writeTps: number };
}

/** One engine session as /slots reports it. */
export interface EngineSlot {
  id: number;
  task: number;
  processing: boolean;
  promptTokens: number;
  cachedTokens: number;
  processedTokens: number;
  generatedTokens: number;
}

/** Reads llama.cpp-style /slots JSON; null when it isn't that. */
export function parseSlots(payload: unknown): EngineSlot[] | null {
  if (!Array.isArray(payload)) return null;
  const slots: EngineSlot[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) return null;
    const slot = item as Record<string, unknown>;
    const id = count(slot.id);
    if (id === null) return null;
    const next = Array.isArray(slot.next_token) ? (slot.next_token[0] as Record<string, unknown> | undefined) : undefined;
    slots.push({
      id,
      task: integer(slot.id_task ?? slot.task_id) ?? -1,
      processing: slot.is_processing === true,
      promptTokens: count(slot.n_prompt_tokens) ?? 0,
      cachedTokens: count(slot.n_prompt_tokens_cache) ?? 0,
      processedTokens: count(slot.n_prompt_tokens_processed) ?? 0,
      generatedTokens: count(next?.n_decoded) ?? 0,
    });
  }
  return slots;
}

/** What the monitor remembers about one engine session (one request) while it runs. */
export interface SessionTrack {
  slot: number;
  task: number;
  /** When the monitor first saw it (it may have started up to POLL_MS earlier). */
  firstSeen: number;
  promptTokens: number;
  cachedTokens: number;
  processedTokens: number;
  /**
   * processedTokens when first seen. The monitor polls only while someone watches, so a session may be well under
   * way by then; its Read counts only what it reads from then on, not everything before over a few seconds.
   */
  baseTokens: number;
  generatedTokens: number;
  /** When processedTokens last changed. */
  processedAt: number | null;
  /** When the first generated token was seen: the prompt was read by then. */
  writingSince: number | null;
  /** Recent generated-token counts, for the write rate. */
  samples: Array<{ t: number; tokens: number }>;
  /** The gateway request it serves, when paired. */
  requestId: number | null;
}

/**
 * Prompt tokens read per second of wall-clock time, from when the session was first seen (its admission, give or
 * take a poll, unless the monitor started later) until the prompt was read, or until the latest progress while it
 * still reads. Wall-clock on purpose: it is what the person waits, with the engine's time shared among sessions.
 */
export function readRate(track: SessionTrack): number | null {
  const read = track.processedTokens - track.baseTokens;
  if (read <= 0) return null;
  const end = track.writingSince ?? track.processedAt;
  if (end === null) return null;
  const span = end - track.firstSeen;
  return span >= MIN_SPAN_MS / 2 ? (read * 1000) / span : null;
}

/** Tokens per second over the recent window of samples; null until there is enough history. */
export function windowRate(samples: ReadonlyArray<{ t: number; tokens: number }>, now: number): number | null {
  const recent = samples.filter((sample) => sample.t >= now - WRITE_WINDOW_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last.t - first.t < MIN_SPAN_MS) return null;
  return ((last.tokens - first.tokens) * 1000) / (last.t - first.t);
}

/**
 * Updates the tracks from a /slots answer: new sessions start a track (keyed by slot and task), known
 * ones record their progress, and sessions that stopped processing are dropped.
 */
export function updateTracks(tracks: Map<string, SessionTrack>, slots: readonly EngineSlot[], now: number): void {
  const seen = new Set<string>();
  for (const slot of slots) {
    if (!slot.processing) continue;
    const key = `${slot.id}:${slot.task}`;
    seen.add(key);
    let track = tracks.get(key);
    if (!track) {
      track = {
        slot: slot.id,
        task: slot.task,
        firstSeen: now,
        promptTokens: slot.promptTokens,
        cachedTokens: slot.cachedTokens,
        processedTokens: slot.processedTokens,
        baseTokens: slot.processedTokens,
        generatedTokens: 0,
        processedAt: null,
        writingSince: null,
        samples: [],
        requestId: null,
      };
      tracks.set(key, track);
    }
    if (slot.processedTokens !== track.processedTokens) {
      track.processedTokens = slot.processedTokens;
      track.processedAt = now;
    }
    track.promptTokens = slot.promptTokens;
    track.cachedTokens = slot.cachedTokens;
    track.generatedTokens = slot.generatedTokens;
    if (slot.generatedTokens > 0) {
      track.writingSince ??= now;
      track.samples.push({ t: now, tokens: slot.generatedTokens });
      while (track.samples.length > 0 && track.samples[0]!.t < now - WRITE_WINDOW_MS) track.samples.shift();
    }
  }
  for (const key of tracks.keys()) if (!seen.has(key)) tracks.delete(key);
}

/**
 * Pairs engine sessions with the gateway's forwarded requests. A pairing whose request has ended is
 * undone. New sessions, in task order, take the oldest unpaired requests that were forwarded before
 * the session was first seen (a session can't serve a request sent after it started).
 */
export function pairSessions(tracks: Iterable<SessionTrack>, requests: readonly ActiveLlmRequest[]): void {
  const forwarded = requests.filter((request) => request.forwardedAt !== null);
  const live = new Set(forwarded.map((request) => request.id));
  const all = [...tracks];
  const paired = new Set<number>();
  for (const track of all) {
    if (track.requestId !== null && !live.has(track.requestId)) track.requestId = null;
    if (track.requestId !== null) paired.add(track.requestId);
  }
  const candidates = forwarded
    .filter((request) => !paired.has(request.id))
    .sort((a, b) => a.forwardedAt! - b.forwardedAt! || a.id - b.id);
  for (const track of all.filter((t) => t.requestId === null).sort((a, b) => a.task - b.task)) {
    const index = candidates.findIndex((request) => request.forwardedAt! <= track.firstSeen);
    if (index === -1) continue;
    track.requestId = candidates[index]!.id;
    candidates.splice(index, 1);
  }
}

export interface LlmMonitorOptions {
  upstreamUrl: string;
  apiKey: string;
  queue: LlmQueue;
  requests: LlmRequests;
  /** Display names for user ids (unknown ids are left out). */
  names: (userIds: readonly number[]) => Map<number, string>;
  log: Logger;
  now?: () => number;
  fetch?: typeof fetch;
}

export class LlmMonitor {
  readonly #options: LlmMonitorOptions;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #tracks = new Map<string, SessionTrack>();
  /** Token counts of forwarded requests, for Write when the engine reports no sessions. */
  readonly #requestSamples = new Map<number, Array<{ t: number; tokens: number }>>();
  #engine: EngineState = "unknown";
  #sessionsReported = false;
  #engineSessions: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(options: LlmMonitorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Starts polling the engine (idempotent). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#tracks.clear();
    this.#requestSamples.clear();
  }

  /** Polls once, now (tests; also the first frame of a new viewer). */
  async poll(): Promise<void> {
    const slots = await this.#fetchSlots();
    // After the fetch: a request forwarded while it ran must count as forwarded before its session was seen.
    const now = this.#now();
    if (slots !== null) updateTracks(this.#tracks, slots, now);
    else this.#tracks.clear();
    const active = this.#options.requests.active();
    pairSessions(this.#tracks.values(), active);
    const live = new Set<number>();
    for (const request of active) {
      if (request.forwardedAt === null) continue;
      live.add(request.id);
      let samples = this.#requestSamples.get(request.id);
      if (!samples) this.#requestSamples.set(request.id, (samples = []));
      samples.push({ t: now, tokens: request.tokens });
      while (samples.length > 0 && samples[0]!.t < now - WRITE_WINDOW_MS) samples.shift();
    }
    for (const id of this.#requestSamples.keys()) if (!live.has(id)) this.#requestSamples.delete(id);
  }

  snapshot(): LlmLive {
    const now = this.#now();
    const { queue, requests } = this.#options;
    const active = requests.active();
    const byId = new Map(active.map((request) => [request.id, request]));
    const waitingInQueue = queue.waiting();
    const sessions: LlmSession[] = [];
    const servedRequests = new Set<number>();

    if (this.#sessionsReported) {
      for (const track of [...this.#tracks.values()].sort((a, b) => a.slot - b.slot)) {
        const request = track.requestId === null ? undefined : byId.get(track.requestId);
        if (request) servedRequests.add(request.id);
        sessions.push({
          slot: track.slot + 1,
          userId: request?.userId ?? null,
          userName: null,
          phase: track.generatedTokens > 0 ? "writing" : track.processedTokens > 0 ? "reading" : "preparing",
          promptTokens: track.promptTokens,
          cachedTokens: track.cachedTokens,
          processedTokens: track.processedTokens,
          generatedTokens: track.generatedTokens,
          readTps: readRate(track),
          writeTps: windowRate(track.samples, now),
          startedAt: request?.forwardedAt ?? track.firstSeen,
        });
      }
    } else {
      for (const request of active) {
        if (request.forwardedAt === null) continue;
        servedRequests.add(request.id);
        sessions.push({
          slot: null,
          userId: request.userId,
          userName: null,
          phase: request.firstTokenAt === null ? "reading" : "writing",
          promptTokens: null,
          cachedTokens: null,
          processedTokens: null,
          generatedTokens: request.tokens,
          readTps: null,
          writeTps: windowRate(this.#requestSamples.get(request.id) ?? [], now),
          startedAt: request.forwardedAt,
        });
      }
    }

    const waiting: LlmWaiting[] = waitingInQueue.map(({ userId, since }) => ({ userId, userName: null, since, stage: "portal" }));
    if (this.#sessionsReported) {
      for (const request of active) {
        if (request.forwardedAt === null || servedRequests.has(request.id) || now - request.forwardedAt < ENGINE_WAIT_GRACE_MS) continue;
        waiting.push({ userId: request.userId, userName: null, since: request.forwardedAt, stage: "engine" });
      }
    }

    const ids = [...sessions, ...waiting].map((row) => row.userId).filter((id): id is number => id !== null);
    const names = ids.length > 0 ? this.#options.names([...new Set(ids)]) : new Map<number, string>();
    for (const row of [...sessions, ...waiting]) row.userName = row.userId === null ? null : (names.get(row.userId) ?? null);

    let readTps = 0;
    let writeTps = 0;
    for (const session of sessions) {
      if (session.phase === "reading" && session.readTps !== null) readTps += session.readTps;
      if (session.phase === "writing" && session.writeTps !== null) writeTps += session.writeTps;
    }
    return {
      engine: this.#engine,
      sessionsReported: this.#sessionsReported,
      engineSessions: this.#engineSessions,
      maxConcurrency: queue.maxConcurrency,
      inFlight: queue.inFlight,
      queued: queue.queued,
      paused: queue.paused,
      sessions,
      waiting,
      totals: { readTps, writeTps },
    };
  }

  async #tick(): Promise<void> {
    if (!this.#running) return;
    const started = this.#now();
    try {
      await this.poll();
    } catch (error) {
      this.#options.log.warn("LLM live view: poll failed", { error });
    }
    if (!this.#running) return;
    this.#timer = setTimeout(() => void this.#tick(), Math.max(0, POLL_MS - (this.#now() - started)));
  }

  /** The engine's sessions, or null when it can't say (and the engine state says why). */
  async #fetchSlots(): Promise<EngineSlot[] | null> {
    const { upstreamUrl, apiKey } = this.#options;
    let response: Response;
    try {
      response = await this.#fetch(`${upstreamUrl}/slots`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(SLOTS_TIMEOUT_MS),
      });
    } catch (error) {
      this.#setEngine("offline", false, null, error instanceof Error ? error.message : String(error));
      return null;
    }
    if (response.status === 503) {
      await response.body?.cancel();
      this.#setEngine("loading", this.#sessionsReported, this.#engineSessions, "");
      return null;
    }
    const slots = response.ok ? parseSlots(await response.json().catch(() => null)) : null;
    if (!response.ok) await response.body?.cancel();
    if (slots === null) {
      // A server without /slots: it answered, so it runs; the rows come from the gateway.
      this.#setEngine(response.ok ? "ready" : "unknown", false, null, "");
      return null;
    }
    this.#setEngine("ready", true, slots.length, "");
    return slots;
  }

  #setEngine(state: EngineState, reported: boolean, sessions: number | null, error: string): void {
    if (state !== this.#engine && (state === "offline" || this.#engine === "offline")) {
      if (state === "offline") this.#options.log.warn("LLM live view: the LLM server is not reachable", { error });
      else this.#options.log.info("LLM live view: the LLM server answers again", { state });
    }
    this.#engine = state;
    this.#sessionsReported = reported;
    this.#engineSessions = sessions;
  }
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
