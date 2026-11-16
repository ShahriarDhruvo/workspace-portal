// Updates (or rolls back) the LLM engine on the LLM server from Admin > Updates, through that server's
// portal-hostd, which owns the engine's Podman quadlet (hostd/README.md).
//
// An update:
//   1. pulling:    hostd downloads the version's image (by digest, resolved from the registry now);
//                  the engine keeps serving meanwhile. Cancellable.
//   2. draining:   the gateway holds new LLM requests in its queue (they wait, they don't fail) and waits
//                  for the running ones to finish: at most ENGINE_DRAIN_MINUTES, or until the admin says
//                  "Restart now". Cancellable (the queue opens again, nothing changed).
//   3. restarting: hostd points the quadlet at the new image, restarts the engine and checks it serves
//                  the new version; if it doesn't, hostd puts the old image back and restarts that.
//   4. the queue opens again; the held requests go to the (new or restored) engine.
// A rollback is the same without step 1: hostd swaps back to the image that ran before the last change.
// One job at a time; the last one stays visible until the next starts.
import crypto from "node:crypto";
import { writeAudit, type AuditAction, type PortalDb } from "@portal/db";
import type { Config } from "./config.ts";
import { EngineReleaseError, EngineReleases, isStableVersion, type EngineReleaseList } from "./engine-releases.ts";
import { HostdClient, HostdError, type EngineJob, type EngineStatus } from "./hostd.ts";
import type { LlmQueue } from "./llm-queue.ts";
import { errorMessage, type Logger } from "./log.ts";

const POLL_MS = 1_000;
const DRAIN_POLL_MS = 250;
const PULL_TIMEOUT_MS = 60 * 60_000;
/**
 * Longer than hostd's worst case, so the gateway never gives up (and lets held requests through) while hostd still
 * works: restart 15 min, then /ready within 10 min, a daemon-reload of up to 2 min, all twice when it rolls back.
 */
const APPLY_TIMEOUT_MS = 75 * 60_000;
const LOG_LINES = 400;
export const CANCELLED = "Cancelled.";
export const GATEWAY_STOPPED = "The gateway stopped during the update; check the engine's version.";

export type EngineJobStage = "pulling" | "draining" | "restarting" | "succeeded" | "failed" | "cancelled";

export interface EngineUpdateJob {
  id: string;
  kind: "update" | "rollback";
  fromVersion: string | null;
  /** The version asked for (an update) or restored (a rollback); null when unknown. */
  toVersion: string | null;
  image: string | null;
  stage: EngineJobStage;
  step: string;
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** hostd put the previous image back after the new one failed. */
  rolledBack: boolean;
  /** While draining: since when, until when at most, and how many requests are still running. */
  drain: { since: number; deadline: number; inFlight: number } | null;
  /** The update can still be cancelled with nothing changed. */
  cancellable: boolean;
  actorUserId: number | null;
}

/** off: no portal-hostd for the LLM server; offline: it can't be reached; no_engine: it controls no engine. */
export type EngineHostState = "off" | "offline" | "no_engine" | "ok";

export interface EngineOverview {
  state: EngineHostState;
  error: string | null;
  engine: EngineStatus | null;
  releases: EngineReleaseList | null;
  job: EngineUpdateJob | null;
  drainMinutes: number;
}

export class EngineUnavailableError extends Error {
  readonly state: EngineHostState;
  constructor(state: EngineHostState, message: string) {
    super(message);
    this.name = "EngineUnavailableError";
    this.state = state;
  }
}

export class EngineJobRunningError extends Error {
  constructor(message = "An engine update is running. Wait for it to finish, or cancel it.") {
    super(message);
    this.name = "EngineJobRunningError";
  }
}

export class EngineRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineRequestError";
    this.code = code;
  }
}

/** What the updater needs from the LLM server's portal-hostd. */
export interface EngineHost {
  status(): Promise<EngineStatus>;
  pull(image: string): Promise<EngineJob>;
  apply(image: string, version: string | null): Promise<EngineJob>;
  rollback(): Promise<EngineJob>;
  cancel(): Promise<boolean>;
  removeImage(digest: string): Promise<void>;
}

export function createEngineHost(client: HostdClient): EngineHost {
  return {
    status: () => client.get<EngineStatus>("/v1/engine"),
    pull: (image) => client.post<EngineJob>("/v1/engine/pull", { image }),
    apply: (image, version) => client.post<EngineJob>("/v1/engine/apply", { image, version }),
    rollback: () => client.post<EngineJob>("/v1/engine/rollback"),
    cancel: async () => (await client.post<{ cancelled: boolean }>("/v1/engine/cancel")).cancelled === true,
    removeImage: async (digest) => {
      await client.delete(`/v1/engine/images/${encodeURIComponent(digest)}`);
    },
  };
}

export interface EngineUpdaterOptions {
  config: Config;
  /** null when the LLM server has no portal-hostd set up. */
  host: EngineHost | null;
  releases: EngineReleases;
  queue: LlmQueue;
  db: PortalDb;
  log: Logger;
  now?: () => number;
  /** Test hook: how long the loops wait between polls. */
  pollMs?: number;
}

export class EngineUpdater {
  readonly #options: EngineUpdaterOptions;
  readonly #now: () => number;
  readonly #pollMs: number;
  #job: EngineUpdateJob | null = null;
  /** The hostd job the current stage follows, for its live log. */
  #hostJob: EngineJob | null = null;
  #cancelRequested = false;
  #restartNow = false;
  #paused = false;

  constructor(options: EngineUpdaterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? POLL_MS;
  }

  get running(): boolean {
    return this.#job !== null && this.#job.finishedAt === null;
  }

  async overview(options: { refresh?: boolean } = {}): Promise<EngineOverview> {
    const { host, releases, config } = this.#options;
    const base = { job: this.snapshot(), drainMinutes: Math.round(config.engine.drainMs / 60_000) };
    if (host === null) return { ...base, state: "off", error: null, engine: null, releases: null };
    let engine: EngineStatus;
    try {
      engine = await host.status();
    } catch (error) {
      if (error instanceof HostdError && error.code === "no_engine") return { ...base, state: "no_engine", error: error.message, engine: null, releases: null };
      return { ...base, state: "offline", error: errorMessage(error), engine: null, releases: null };
    }
    return { ...base, state: "ok", error: null, engine, releases: await releases.list(engine.repository, options) };
  }

  snapshot(): EngineUpdateJob | null {
    const job = this.#job;
    if (job === null) return null;
    const live = this.#hostJob && job.finishedAt === null ? this.#hostJob.log : [];
    return { ...job, log: [...job.log, ...live].slice(-LOG_LINES), drain: job.drain && { ...job.drain, inFlight: this.#options.queue.inFlight } };
  }

  /** Starts an update to `version` (X.Y.Z); resolves once it has started. */
  async startUpdate(request: { version: string; actorUserId: number | null }): Promise<EngineUpdateJob> {
    const { version, actorUserId } = request;
    if (!isStableVersion(version)) throw new EngineRequestError("invalid_version", "version must be a release version, like 0.34.0.");
    const { engine, host } = await this.#ready();
    if (engine.version === version) throw new EngineRequestError("already_current", `The engine already runs ${version}.`);
    let digest: string;
    try {
      digest = await this.#options.releases.resolve(engine.repository, version);
    } catch (error) {
      if (error instanceof EngineReleaseError) throw new EngineRequestError("version_not_found", error.message);
      throw error;
    }
    if (this.running) throw new EngineJobRunningError();
    const image = `${engine.repository}@${digest}`;
    const job = this.#begin("update", engine.version, version, image, actorUserId);
    void this.#run(job, host, {
      beforeDrain: async () => {
        this.#stage(job, "pulling", `Downloading ${version}`, true);
        const pulled = await this.#follow(job, await host.pull(image), host, PULL_TIMEOUT_MS);
        if (pulled.phase === "cancelled" || this.#cancelRequested) throw new Cancelled();
        if (pulled.phase !== "succeeded") throw new Error(pulled.error ?? "The download failed.");
      },
      restart: () => host.apply(image, version),
    });
    return this.snapshot()!;
  }

  /** Swaps back to the image that ran before the last engine change. */
  async startRollback(request: { actorUserId: number | null }): Promise<EngineUpdateJob> {
    const { engine, host } = await this.#ready();
    if (engine.previous === null) throw new EngineRequestError("no_previous", "There is no previous engine version to go back to.");
    if (this.running) throw new EngineJobRunningError();
    const job = this.#begin("rollback", engine.version, engine.previous.version, engine.previous.image, request.actorUserId);
    void this.#run(job, host, { restart: () => host.rollback() });
    return this.snapshot()!;
  }

  /** Cancels a job that is still downloading or draining; false when there is none or it is too late. */
  async cancel(): Promise<boolean> {
    const job = this.#job;
    if (!job || job.finishedAt !== null || !job.cancellable) return false;
    this.#cancelRequested = true;
    if (job.stage === "pulling") await this.#options.host?.cancel().catch(() => false);
    return true;
  }

  /** Ends the drain now: the engine restarts even though requests are still running. */
  restartNow(): boolean {
    if (this.#job?.stage !== "draining" || this.#job.finishedAt !== null) return false;
    this.#restartNow = true;
    return true;
  }

  /** Removes a local engine image (not the running one). The web app audits it, with the admin who asked. */
  async removeImage(digest: string): Promise<void> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new EngineRequestError("invalid_digest", "digest must be sha256:<64 hex digits>.");
    if (this.running) throw new EngineJobRunningError();
    const host = this.#options.host;
    if (host === null) throw new EngineUnavailableError("off", "The LLM server's portal-hostd is not set up.");
    await host.removeImage(digest);
  }

  /** At gateway shutdown: a running job is recorded as failed (hostd carries on with what it was doing). */
  shutdown(): void {
    const job = this.#job;
    if (!job || job.finishedAt !== null) return;
    this.#finish(job, "failed", GATEWAY_STOPPED);
  }

  async #ready(): Promise<{ engine: EngineStatus; host: EngineHost }> {
    const host = this.#options.host;
    if (host === null) throw new EngineUnavailableError("off", "The LLM server's portal-hostd is not set up (HOSTD_LLM_URL, HOSTD_LLM_TOKEN).");
    if (this.running) throw new EngineJobRunningError();
    try {
      return { engine: await host.status(), host };
    } catch (error) {
      if (error instanceof HostdError && error.code === "no_engine") throw new EngineUnavailableError("no_engine", error.message);
      throw new EngineUnavailableError("offline", `The LLM server's portal-hostd can't be reached: ${errorMessage(error)}`);
    }
  }

  #begin(kind: "update" | "rollback", fromVersion: string | null, toVersion: string | null, image: string | null, actorUserId: number | null): EngineUpdateJob {
    this.#cancelRequested = false;
    this.#restartNow = false;
    this.#hostJob = null;
    const job: EngineUpdateJob = {
      id: crypto.randomBytes(6).toString("hex"),
      kind,
      fromVersion,
      toVersion,
      image,
      stage: kind === "update" ? "pulling" : "draining",
      step: "Starting",
      log: [],
      startedAt: this.#now(),
      finishedAt: null,
      error: null,
      rolledBack: false,
      drain: null,
      cancellable: true,
      actorUserId,
    };
    this.#job = job;
    this.#options.log.info(kind === "update" ? "engine update started" : "engine rollback started", { from: fromVersion, to: toVersion });
    return job;
  }

  /** Runs a job: what comes before the drain (an update's download), the drain, then hostd's restart. */
  async #run(job: EngineUpdateJob, host: EngineHost, plan: { beforeDrain?: () => Promise<void>; restart: () => Promise<EngineJob> }): Promise<void> {
    const { queue } = this.#options;
    try {
      await plan.beforeDrain?.();
      await this.#drain(job);
      this.#stage(job, "restarting", `Restarting the engine with ${job.toVersion ?? "the previous version"}`, false);
      const result = await this.#follow(job, await plan.restart(), host, APPLY_TIMEOUT_MS);
      if (result.phase !== "succeeded") {
        job.rolledBack = result.rolledBack;
        throw new Error(result.error ?? "The engine did not come up with the new version.");
      }
      if (job.finishedAt !== null) return; // shutdown() recorded it
      const reached = await host.status().catch(() => null);
      if (reached?.version) job.toVersion = reached.version;
      this.#finish(job, "succeeded", null);
    } catch (error) {
      if (job.finishedAt !== null) return;
      if (error instanceof Cancelled) this.#finish(job, "cancelled", CANCELLED);
      else this.#finish(job, "failed", errorMessage(error));
    } finally {
      if (this.#paused) {
        this.#paused = false;
        queue.resume();
      }
      this.#hostJob = null;
    }
  }

  /** Holds new requests and waits for the running ones (or the deadline, or "Restart now"). */
  async #drain(job: EngineUpdateJob): Promise<void> {
    const { queue, config } = this.#options;
    const since = this.#now();
    const deadline = since + config.engine.drainMs;
    queue.pause();
    this.#paused = true;
    job.drain = { since, deadline, inFlight: queue.inFlight };
    this.#stage(job, "draining", "Waiting for running requests to finish", true);
    this.#note(job, `New LLM requests wait in the portal's queue; ${queue.inFlight} still running.`);
    while (queue.inFlight > 0) {
      if (this.#cancelRequested || job.finishedAt !== null) throw new Cancelled();
      if (this.#restartNow) {
        this.#note(job, `Restarting now on request; ${queue.inFlight} running request(s) will be cut off.`);
        break;
      }
      if (this.#now() >= deadline) {
        this.#note(job, `Still ${queue.inFlight} running after ${Math.round(config.engine.drainMs / 60_000)} minutes; restarting anyway.`);
        break;
      }
      await delay(Math.min(DRAIN_POLL_MS, this.#pollMs));
    }
    if (this.#cancelRequested || job.finishedAt !== null) throw new Cancelled();
    job.drain = null;
    job.cancellable = false;
  }

  #stage(job: EngineUpdateJob, stage: EngineJobStage, step: string, cancellable: boolean): void {
    job.stage = stage;
    job.step = step;
    job.cancellable = cancellable;
    this.#note(job, `${step}.`);
  }

  /** Follows a hostd job until it ends; its log becomes part of ours. */
  async #follow(job: EngineUpdateJob, started: EngineJob, host: EngineHost, timeoutMs: number): Promise<EngineJob> {
    this.#hostJob = started;
    const until = this.#now() + timeoutMs;
    let unreachableSince: number | null = null;
    while (this.#now() < until) {
      await delay(this.#pollMs);
      if (job.finishedAt !== null) throw new Cancelled();
      let status: EngineStatus;
      try {
        status = await host.status();
        unreachableSince = null;
      } catch (error) {
        // The LLM server may be busy restarting; keep trying until the time limit.
        if (unreachableSince === null) {
          unreachableSince = this.#now();
          this.#note(job, `portal-hostd did not answer (${errorMessage(error)}); still trying.`);
        }
        continue;
      }
      const current = status.job;
      if (!current || current.id !== started.id) continue;
      this.#hostJob = current;
      if (current.step) job.step = current.step;
      if (current.phase !== "running") {
        job.log.push(...current.log);
        this.#hostJob = null;
        return current;
      }
    }
    throw new Error(`portal-hostd's ${started.kind} did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`);
  }

  #note(job: EngineUpdateJob, line: string): void {
    job.log.push(line);
    if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
  }

  #finish(job: EngineUpdateJob, stage: "succeeded" | "failed" | "cancelled", error: string | null): void {
    job.stage = stage;
    job.finishedAt = this.#now();
    job.error = error;
    job.drain = null;
    job.cancellable = false;
    job.step = stage === "succeeded" ? "Done" : stage === "cancelled" ? "Cancelled" : job.rolledBack ? "Failed; the previous version runs again" : "Failed";
    const details = { kind: job.kind, from: job.fromVersion, to: job.toVersion };
    if (stage === "succeeded") {
      this.#audit("engine_updated", job.actorUserId, details);
      this.#options.log.info(job.kind === "update" ? "engine updated" : "engine rolled back", { ...details, seconds: Math.round((job.finishedAt - job.startedAt) / 1000) });
    } else {
      this.#audit("engine_update_failed", job.actorUserId, { ...details, error, rolledBack: job.rolledBack });
      this.#options.log.warn(stage === "cancelled" ? "engine update cancelled" : "engine update failed", { ...details, error, rolledBack: job.rolledBack });
    }
  }

  #audit(action: AuditAction, actorUserId: number | null, details: unknown): void {
    try {
      writeAudit(this.#options.db, { action, actorUserId, details });
      return;
    } catch (error) {
      // The admin may have been deleted while the job ran (the actor is a foreign key): keep the entry.
      if (actorUserId === null) return void this.#options.log.error("could not write audit entry", { action, error });
    }
    this.#audit(action, null, details);
  }
}

class Cancelled extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
