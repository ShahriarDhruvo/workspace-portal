// The live view of the AI server for Admin > Usage: for each request it is working on, how fast it reads the prompt
// ("Read": prompt tokens processed per second) and writes the answer ("Write": generated tokens per second), the
// totals, and who is waiting. Two sources, joined:
// - The engine's own sessions, from `GET /slots` (llama.cpp's server and engines derived from it, such as gufo): live
//   prompt progress and generated-token counts per session, polled every POLL_MS only while someone watches. Behind
//   llama-swap that is /upstream/<model>/slots (LLM_SLOTS_PATH), which answers 409 while the LLM is not loaded and
//   never starts it.
// - The gateway's record of each request (llm-requests.ts): whose it is, its queue time and its first token.
// The engine doesn't say whose request a session serves. It numbers requests (id_task) in the order they arrive, and
// the gateway forwards them in order, so new sessions are paired, in task order, with the oldest unpaired requests
// that were forwarded before the session was first seen. Without /slots (another kind of server) the rows come from
// the gateway alone: Write from the streamed tokens, and no Read.
// Image and media requests (media.json) take no engine session: behind llama-swap they wait while the LLM is loaded,
// and are being made while it is stopped (409), except those of a model that runs beside the LLM (besideLlm), which
// are made while it runs. Their servers report no progress but a video's, so a row says only that, and the pace of
// the finished ones comes from llm-requests.ts and video-jobs.ts.
import type { EngineState, GenerationKind, LlmGeneration, LlmLive, LlmSession, LlmWaiting } from "@portal/core";
import type { LlmQueue } from "../service/llm-queue.ts";
import type { VideoJobs } from "../service/video-jobs.ts";
import type { ActiveLlmRequest, LlmRequests } from "./llm-requests.ts";
import { errorMessage, type Logger } from "../lib/log.ts";
import { tokenCount as count } from "./usage.ts";

const POLL_MS = 500;
const SLOTS_TIMEOUT_MS = 1_500;
/** Write rates are measured over this much recent history. */
const WRITE_WINDOW_MS = 3_000;
/** A rate needs at least this much history to mean anything. */
const MIN_SPAN_MS = 800;
/** A forwarded request without an engine session for this long is shown as waiting in the engine. */
const ENGINE_WAIT_GRACE_MS = 1_000;

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
 * Updates the tracks from a /slots answer: new sessions start a track (keyed by slot and task), known ones record
 * their progress, and sessions that stopped processing are dropped.
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
 * Pairs engine sessions with the gateway's forwarded requests. A pairing whose request has ended is undone. New
 * sessions, in task order, take the oldest unpaired requests that were forwarded before the session was first seen
 * (a session can't serve a request sent after it started).
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
  /** Where the engine reports its sessions, from upstreamUrl: /slots, or llama-swap's /upstream/<model>/slots. */
  slotsPath?: string;
  apiKey: string;
  queue: LlmQueue;
  requests: LlmRequests;
  /** Display names for user ids (unknown ids are left out). */
  names: (userIds: readonly number[]) => Map<number, string>;
  /** The AI server has image or media models (media.json): the frame then sums up their work. */
  generation?: boolean;
  /** The models that run beside the LLM (media.json's besideLlm): their requests are sessions while the LLM runs. */
  besideLlm?: ReadonlySet<string>;
  /** The video jobs that hold the gateway's queue (video-jobs.ts). */
  video?: { jobs: Pick<VideoJobs, "active" | "pace"> };
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
    pairSessions(this.#tracks.values(), active.filter((request) => request.image === null && request.media === null));
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
    const sessions: LlmSession[] = [];
    const served = new Set<number>();
    // Behind llama-swap: the LLM is stopped while an image or media model has its memory, or is starting again.
    const llmStopped = this.#engine === "unloaded";
    const behind = queuedBehind(active);

    if (this.#sessionsReported) {
      for (const track of [...this.#tracks.values()].sort((a, b) => a.slot - b.slot)) {
        const request = track.requestId === null ? undefined : byId.get(track.requestId);
        if (request) served.add(request.id);
        sessions.push({
          slot: track.slot + 1,
          userId: request?.userId ?? null,
          userName: null,
          phase: track.generatedTokens > 0 ? "writing" : track.processedTokens > 0 ? "reading" : "preparing",
          model: null,
          promptTokens: track.promptTokens,
          cachedTokens: track.cachedTokens,
          processedTokens: track.processedTokens,
          generatedTokens: track.generatedTokens,
          readTps: readRate(track),
          writeTps: windowRate(track.samples, now),
          startedAt: request?.forwardedAt ?? track.firstSeen,
        });
      }
      // A model beside the LLM (media.json's besideLlm: speech and transcription): no session of the LLM's, and no
      // swap to wait for.
      const beside = this.#options.besideLlm;
      for (const request of active) {
        const model = request.media?.model ?? request.image?.model ?? null;
        if (request.forwardedAt === null || model === null || !beside?.has(model) || behind.has(request.id)) continue;
        served.add(request.id);
        sessions.push(mediaSession(request.userId, request.media?.kind ?? "image", model, request.forwardedAt));
      }
    } else {
      for (const request of active) {
        const llm = request.image === null && request.media === null;
        if (request.forwardedAt === null || (llm && llmStopped) || behind.has(request.id)) continue;
        served.add(request.id);
        sessions.push({
          slot: null,
          userId: request.userId,
          userName: null,
          phase: request.media?.kind ?? (request.image !== null ? "image" : request.firstTokenAt === null ? "reading" : "writing"),
          model: request.media?.model ?? request.image?.model ?? null,
          promptTokens: null,
          cachedTokens: null,
          processedTokens: null,
          generatedTokens: request.tokens,
          readTps: null,
          writeTps: llm ? windowRate(this.#requestSamples.get(request.id) ?? [], now) : null,
          startedAt: request.forwardedAt,
        });
      }
    }

    // A running video job is its user's session though no request of it is in flight.
    const { video } = this.#options;
    const jobs = video?.jobs.active() ?? [];
    for (const job of jobs) sessions.push(mediaSession(job.userId, "video", job.model, job.startedAt));
    const held = queue.held;
    const waiting: LlmWaiting[] = queue.waiting().map(({ userId, since }) => ({ userId, userName: null, since, stage: held ? "video" : "portal" }));
    for (const request of active) {
      if (request.forwardedAt === null || served.has(request.id) || now - request.forwardedAt < ENGINE_WAIT_GRACE_MS) continue;
      if (!this.#sessionsReported && !llmStopped && !behind.has(request.id)) continue;
      // An image or media request beside the loaded LLM, or an LLM request while it is stopped, waits for llama-swap to
      // swap; one behind another on its model waits in that model's server.
      const swaps = !behind.has(request.id) && (request.image !== null || request.media !== null || llmStopped);
      waiting.push({ userId: request.userId, userName: null, since: request.forwardedAt, stage: swaps ? "swap" : "engine" });
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
    const generation = this.#options.generation ? this.#generation(sessions, jobs, now) : null;
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
      totals: llmStopped ? { readTps: null, writeTps: null } : { readTps, writeTps },
      generation,
      videoJobs: jobs.length,
    };
  }

  /** What the image and media models are making (a video first), else made last: LlmGeneration. */
  #generation(sessions: readonly LlmSession[], jobs: ReturnType<VideoJobs["active"]>, now: number): LlmGeneration {
    const { requests, video } = this.#options;
    const making = (kind: GenerationKind) => sessions.filter((session) => session.phase === kind);
    const busy = GENERATION_ORDER.find((kind) => making(kind).length > 0);
    const videoPace = video?.jobs.pace() ?? null;
    const last = requests.lastGeneration();
    // Nothing being made: the kind finished last, a video when its job completed after every request.
    const kind: GenerationKind | null = busy ?? (videoPace !== null && (last === null || videoPace.at >= last.at) ? "video" : (last?.kind ?? null));
    if (kind === null) return { kind: null, making: 0, model: null, video: null, pace: null };
    const running = making(kind);
    const pace = kind === "video" ? (videoPace && { model: videoPace.model, seconds: videoPace.seconds }) : requests.pace(kind);
    const job = kind === "video" ? jobs[0] : undefined;
    return {
      kind,
      making: running.length,
      model: running[0]?.model ?? pace?.model ?? null,
      video: job ? { progress: job.progress, elapsedSeconds: Math.max(0, Math.round((now - job.startedAt) / 1000)) } : null,
      pace,
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
    const { upstreamUrl, slotsPath = "/slots", apiKey } = this.#options;
    let response: Response;
    try {
      response = await this.#fetch(`${upstreamUrl}${slotsPath}`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(SLOTS_TIMEOUT_MS),
      });
    } catch (error) {
      this.#setEngine("offline", false, null, errorMessage(error));
      return null;
    }
    if (response.status === 503) {
      await response.body?.cancel();
      this.#setEngine("loading", this.#sessionsReported, this.#engineSessions, "");
      return null;
    }
    // llama-swap: the LLM is stopped (an image or media model has its memory) or is starting again.
    if (response.status === 409) {
      await response.body?.cancel();
      this.#setEngine("unloaded", false, null, "");
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
      if (state === "offline") this.#options.log.warn("LLM live view: the AI server is not reachable", { error });
      else this.#options.log.info("LLM live view: the AI server answers again", { state });
    }
    this.#engine = state;
    this.#sessionsReported = reported;
    this.#engineSessions = sessions;
  }
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** The order the frame picks a kind in when several are being made: the longest work first. */
const GENERATION_ORDER: readonly GenerationKind[] = ["video", "music", "speech", "transcription", "image"];

/** The image and media requests behind an older one on their model, which makes one thing at a time. */
function queuedBehind(active: readonly ActiveLlmRequest[]): Set<number> {
  const forwarded = active.filter((request) => request.forwardedAt !== null && (request.image !== null || request.media !== null));
  const seen = new Set<string>();
  const behind = new Set<number>();
  for (const request of forwarded.sort((a, b) => a.forwardedAt! - b.forwardedAt!)) {
    const key = request.image !== null ? `image:${request.image.model ?? ""}` : `${request.media!.kind}:${request.media!.model ?? ""}`;
    if (seen.has(key)) behind.add(request.id);
    else seen.add(key);
  }
  return behind;
}

/** A media model's request, or a running video job, as a row of the sessions table. */
function mediaSession(userId: number, phase: GenerationKind, model: string | null, startedAt: number): LlmSession {
  return { slot: null, userId, userName: null, phase, model, promptTokens: null, cachedTokens: null, processedTokens: null, generatedTokens: 0, readTps: null, writeTps: null, startedAt };
}
