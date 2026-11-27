// The video jobs of the AI server's video models (media.json's video, OpenAI's /v1/videos job API). A job runs after the
// request that created it has ended, so behind llama-swap it is no request in flight: the next request for any other
// model would stop the video model, and the job with it. So a create has the AI server to itself, and from then
// until its job ends the gateway's queue grants no generation (LlmQueue.acquireAlone); the gateway asks the server
// how each job is doing to know when it ended.
// A completed job holds on until its user has downloaded the video (or for downloadGraceMs): a download after another
// model took the GPU would load the video model again just to send the file. A job is its user's: asking about
// another's is answered as if it did not exist. Each job is its model's: its status, download and cancel go there.
import type { VideoHold } from "@portal/core";
import type { Logger } from "../lib/log.ts";
import { median } from "../lib/stats.ts";
import type { LlmQueue, ReleaseSlot } from "./llm-queue.ts";

/** OpenAI's statuses of a job that has not ended; any other (completed, failed, cancelled, expired) has. */
const RUNNING = new Set(["queued", "in_progress"]);

export interface VideoJobsOptions {
  /** The job on `model`'s server, or null when the server does not know it (404). Throws when it cannot be asked. */
  status: (id: string, model: string) => Promise<VideoStatus | null>;
  log: Logger;
  now?: () => number;
  /** How often each running job is asked about. */
  pollMs?: number;
  /** A job the server has not answered about for this long is taken to have ended. */
  lostAfterMs?: number;
  /** The longest a job may hold the queue. */
  maxRunMs?: number;
  /** How long a completed job that has not been downloaded holds the queue. */
  downloadGraceMs?: number;
  /** How long an ended job stays its user's to download: the video server keeps it as long (its --ttl). */
  keepMs?: number;
}

/** What the video server says of a job: OpenAI's `status`, and `progress` in percent where it gives one. */
export interface VideoStatus {
  status: string;
  progress: number | null;
}

interface Job {
  userId: number;
  /** The video model making it. */
  model: string;
  createdAt: number;
  /** Percent done at the server's last answer. */
  progress: number | null;
  /** When the server last answered about it. */
  answeredAt: number;
  /** When the server first said it completed. */
  completedAt: number | null;
  /** null once it has ended. */
  release: ReleaseSlot | null;
  endedAt: number | null;
}

export class VideoJobs {
  readonly #options: Required<VideoJobsOptions>;
  readonly #jobs = new Map<string, Job>();
  /** How long the last completed jobs took, from create to completed, oldest first. */
  readonly #paces: Array<{ model: string; seconds: number; at: number }> = [];
  #timer: NodeJS.Timeout | null = null;
  #polling = false;

  constructor(options: VideoJobsOptions) {
    const { now = Date.now, pollMs = 5_000, lostAfterMs = 10 * 60_000, maxRunMs = 12 * 3_600_000, downloadGraceMs = 5 * 60_000, keepMs = 3_600_000 } = options;
    this.#options = { ...options, now, pollMs, lostAfterMs, maxRunMs, downloadGraceMs, keepMs };
  }

  /** The jobs that hold the queue now, oldest first. */
  active(): Array<{ userId: number; model: string; startedAt: number; progress: number | null }> {
    return [...this.#jobs.values()]
      .filter((job) => job.release !== null)
      .map((job) => ({ userId: job.userId, model: job.model, startedAt: job.createdAt, progress: job.progress }));
  }

  /**
   * The median time of the last five completed jobs of the model that completed one last, from create to completed,
   * and when that last one completed; null before any.
   */
  pace(): { model: string; seconds: number; at: number } | null {
    const last = this.#paces.at(-1);
    if (!last) return null;
    const seconds = median(this.#paces.filter((pace) => pace.model === last.model).slice(-5).map((pace) => pace.seconds));
    return { model: last.model, seconds, at: last.at };
  }

  /** Jobs that hold the queue now. */
  get running(): number {
    let count = 0;
    for (const job of this.#jobs.values()) if (job.release !== null) count++;
    return count;
  }

  /**
   * Call before a create is forwarded, with the queue's hold (LlmQueue.acquireAlone's `unhold`). `created` with the
   * new job's id keeps the hold until the job ends; `failed` lets go. Either may be called once.
   */
  creating(userId: number, model: string, release: ReleaseSlot): { created(id: string): void; failed(): void } {
    let settled = false;
    return {
      created: (id) => {
        if (settled) return;
        settled = true;
        const now = this.#options.now();
        this.#jobs.get(id)?.release?.();
        this.#jobs.set(id, { userId, model, createdAt: now, progress: null, answeredAt: now, completedAt: null, release, endedAt: null });
        this.#options.log.info("video job started", { userId, id, model });
        this.#schedule();
      },
      failed: () => {
        if (settled) return;
        settled = true;
        release();
      },
    };
  }

  /** Whether `id` is one of `userId`'s jobs. */
  owns(userId: number, id: string): boolean {
    this.#forgetOld();
    return this.#jobs.get(id)?.userId === userId;
  }

  /** The video model making `id`; null for a job the gateway does not know. */
  /** The job has not ended: it holds the queue, and its model stays loaded for it. */
  holds(id: string): boolean {
    return (this.#jobs.get(id)?.release ?? null) !== null;
  }

  modelOf(id: string): string | null {
    return this.#jobs.get(id)?.model ?? null;
  }

  /** The job's video was downloaded, or the job was cancelled: it holds the queue no longer. */
  done(id: string, why: "downloaded" | "cancelled"): void {
    const job = this.#jobs.get(id);
    if (job) this.#end(id, job, why);
  }

  /** Asks about the running jobs now, as the timer does. Exposed for tests. */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const { now, status, lostAfterMs, maxRunMs, downloadGraceMs, log } = this.#options;
      for (const [id, job] of this.#jobs) {
        if (job.release === null) continue;
        try {
          const answer = await status(id, job.model);
          const state = answer?.status ?? null;
          job.answeredAt = now();
          if (answer?.progress !== null && answer?.progress !== undefined) job.progress = answer.progress;
          if (state === "completed") {
            if (job.completedAt === null) {
              job.completedAt = now();
              this.#paces.push({ model: job.model, seconds: (job.completedAt - job.createdAt) / 1000, at: job.completedAt });
              if (this.#paces.length > 20) this.#paces.shift();
            }
            if (now() - job.completedAt >= downloadGraceMs) this.#end(id, job, "completed, not downloaded");
          } else if (state === null || !RUNNING.has(state)) this.#end(id, job, state ?? "unknown to the server");
        } catch (error) {
          if (now() - job.answeredAt >= lostAfterMs) {
            log.warn("video job: the AI server did not answer about it", { id, error });
            this.#end(id, job, "lost");
          }
        }
        if (job.release !== null && now() - job.createdAt >= maxRunMs) this.#end(id, job, "ran too long");
      }
    } finally {
      this.#polling = false;
    }
    this.#forgetOld();
  }

  #end(id: string, job: Job, why: string): void {
    if (job.release === null) return;
    job.release();
    job.release = null;
    job.endedAt = this.#options.now();
    this.#options.log.info("video job ended", { userId: job.userId, id, model: job.model, status: why, ms: job.endedAt - job.createdAt });
  }

  #forgetOld(): void {
    const now = this.#options.now();
    for (const [id, job] of this.#jobs) if (job.endedAt !== null && now - job.endedAt >= this.#options.keepMs) this.#jobs.delete(id);
  }

  #schedule(): void {
    if (this.#timer !== null || this.running === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.poll().finally(() => this.#schedule());
    }, this.#options.pollMs);
    this.#timer.unref();
  }
}

/** VideoJobs' `status`: asks the AI server at `url(id, model)` for the job, with the AI server's key. */
export function fetchVideoStatus(url: (id: string, model: string) => string, apiKey: string): (id: string, model: string) => Promise<VideoStatus | null> {
  return async (id, model) => {
    const response = await fetch(url(id, model), { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`the AI server answered ${response.status}`);
    const { status, progress } = ((await response.json()) ?? {}) as { status?: unknown; progress?: unknown };
    if (typeof status !== "string") throw new Error("the AI server's answer has no status");
    return { status, progress: typeof progress === "number" && Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : null };
  };
}

/** The oldest running video job, as `userId`'s workspace shows it (WorkspaceInfo.videoHold); null when none runs. */
export function videoHold(jobs: Pick<VideoJobs, "active">, queue: Pick<LlmQueue, "waiting">, userId: number, now: number): VideoHold | null {
  const [job] = jobs.active();
  if (job === undefined) return null;
  const waiting = queue.waiting().filter((waiter) => waiter.userId === userId).length;
  return { elapsedSeconds: Math.max(0, Math.round((now - job.startedAt) / 1000)), progress: job.progress, own: job.userId === userId, waiting };
}
