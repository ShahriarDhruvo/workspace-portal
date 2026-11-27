// Updates the other software on the AI server through its portal-hostd (llm-server/apps.json, hostd/README.md):
// llama-swap and the media models' servers. hostd installs a version beside the running one (a directory, or an image
// it pulls) while everything keeps serving; then the gateway holds new LLM requests in its queue while the running
// ones finish, and hostd switches to the new version and checks it serves, putting the old one back when it does not.
// One job at a time, across these and Gufo's (hostd refuses a second as well).
import crypto from "node:crypto";
import type { AppHostJob, AppStatus, AppsOverview, AppUpdateJob, AppUpdatePhase, PortalDb } from "@portal/core";
import type { Config } from "../config.ts";
import { APP_VERSION, AppReleases } from "./app-releases.ts";
import { EngineReleaseError } from "./engine-releases.ts";
import { HostdClient, HostdError, REMOVE_TIMEOUT_MS } from "../monitor/hostd.ts";
import type { LlmQueue } from "../service/llm-queue.ts";
import { HttpError } from "../lib/http-util.ts";
import { errorMessage, type Logger } from "../lib/log.ts";
import { Cancelled, drainQueue, drainRunning, followHostJob, type JobControl } from "./host-update.ts";
import { appendLog, finishJob } from "./update-job.ts";

const POLL_MS = 1_000;
/** Longer than hostd's limit on an install (3 hours: a Python app's dependencies over a slow line). */
const INSTALL_TIMEOUT_MS = 3.5 * 60 * 60_000;
/**
 * Longer than hostd's worst case for a switch: stopping the models and the app's unit (15 min each), starting it and
 * waiting for it to serve (15 min), all twice when it rolls back, then loading the LLM again (15 min).
 */
const APPLY_TIMEOUT_MS = 2 * 60 * 60_000;
const LOG_LINES = 400;
export const CANCELLED = "Cancelled.";
export const GATEWAY_STOPPED = "The gateway stopped during the update; check the program's version on the AI server.";
export const OLD_HOSTD = "portal-hostd on the AI server is older than this portal and updates no other software: install it again there.";
export const NO_APPS =
  "portal-hostd on the AI server updates no other software: its installer ran there with --apps none, or without engine control.";

const invalidVersion = (): HttpError => new HttpError(400, "invalid_version", "version must be 1-64 letters, digits and . + _ -.");
const unavailable = (message: string): HttpError => new HttpError(503, "apps_unavailable", message);
const jobRunning = (): HttpError =>
  new HttpError(409, "app_job_running", "An update of other software on the AI server is running. Wait for it to finish, or cancel it.");
const engineRunning = (): HttpError => new HttpError(409, "engine_job_running", "An engine update is running. Wait for it to finish, or cancel it.");

/** What the updater needs from the AI server's portal-hostd. */
export interface AppHost {
  status(): Promise<{ apps: AppStatus[]; job: AppHostJob | null }>;
  /** A dir app takes the version alone; an image app the image (repository@digest) and its tag too. */
  install(app: string, request: { version: string; image?: string; tag?: string }): Promise<AppHostJob>;
  apply(app: string, version: string): Promise<AppHostJob>;
  cancel(): Promise<boolean>;
  remove(app: string, version: string): Promise<void>;
}

export function createAppHost(client: HostdClient): AppHost {
  const path = (app: string) => `/v1/apps/${encodeURIComponent(app)}`;
  return {
    status: () => client.get<{ apps: AppStatus[]; job: AppHostJob | null }>("/v1/apps"),
    install: (app, request) => client.post<AppHostJob>(`${path(app)}/install`, request),
    apply: (app, version) => client.post<AppHostJob>(`${path(app)}/apply`, { version }),
    cancel: async () => (await client.post<{ cancelled: boolean }>("/v1/apps/cancel")).cancelled === true,
    remove: async (app, version) => {
      await client.delete(`${path(app)}/versions/${encodeURIComponent(version)}`, REMOVE_TIMEOUT_MS);
    },
  };
}

export interface AppUpdaterOptions {
  config: Config;
  /** null when the AI server has no portal-hostd set up. */
  host: AppHost | null;
  releases: AppReleases;
  queue: LlmQueue;
  db: PortalDb;
  log: Logger;
  now?: () => number;
  /** Test hook: how long the loops wait between polls. */
  pollMs?: number;
  /** Gufo's updater, through the same portal-hostd, runs a job. */
  busy?: () => boolean;
}

export class AppUpdater {
  readonly #options: AppUpdaterOptions;
  readonly #now: () => number;
  readonly #pollMs: number;
  #job: AppUpdateJob | null = null;
  /** The hostd job the current phase follows, for its live log. */
  #hostJob: AppHostJob | null = null;
  #control: JobControl = { cancelRequested: false, restartNow: false };

  constructor(options: AppUpdaterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? POLL_MS;
  }

  get running(): boolean {
    return this.#job !== null && this.#job.finishedAt === null;
  }

  async overview(options: { refresh?: boolean } = {}): Promise<AppsOverview> {
    const { host, releases, config } = this.#options;
    const base = { job: this.snapshot(), drainMinutes: Math.round(config.engine.drainMs / 60_000), apps: [] };
    if (host === null) return { ...base, state: "off", error: null };
    let apps: AppStatus[];
    try {
      apps = (await host.status()).apps;
    } catch (error) {
      if (error instanceof HostdError && error.code === "no_apps") return { ...base, state: "no_apps", error: NO_APPS };
      // A portal-hostd from before these updates has no /v1/apps.
      if (error instanceof HostdError && error.status === 404) return { ...base, state: "no_apps", error: OLD_HOSTD };
      return { ...base, state: "offline", error: errorMessage(error) };
    }
    const lists = await releases.list(apps, options);
    return { ...base, state: "ok", error: null, apps: apps.map((status) => ({ status, releases: lists.get(status.id)! })) };
  }

  snapshot(): AppUpdateJob | null {
    const job = this.#job;
    if (job === null) return null;
    const live = this.#hostJob && job.finishedAt === null ? this.#hostJob.log : [];
    return { ...job, log: [...job.log, ...live].slice(-LOG_LINES), drain: job.drain && { ...job.drain, ...drainRunning(this.#options.queue) } };
  }

  /**
   * Starts switching `app` to `version` (newer or older); resolves once it has started. A version installed on the AI
   * server is used as it is; any other is installed first (an image app's resolved to its digest in the registry).
   */
  async startUpdate(request: { app: string; version: string; actorUserId: number | null }): Promise<AppUpdateJob> {
    const { app: id, version, actorUserId } = request;
    const { host, releases, log } = this.#options;
    if (!APP_VERSION.test(version)) throw invalidVersion();
    if (host === null) throw unavailable("The AI server's portal-hostd is not set up (HOSTD_LLM_URL, HOSTD_LLM_TOKEN).");
    this.#idle();
    const app = await this.#status(host, id);
    if (app.version === version) throw new HttpError(409, "already_current", `${app.name} already runs ${version}.`);
    const reuse = app.versions.some((installed) => installed.version === version);
    const image = reuse
      ? null
      : await releases.resolve(app, version).catch((error: unknown) => {
          throw error instanceof EngineReleaseError ? new HttpError(404, "version_not_found", error.message) : error;
        });
    this.#idle();
    this.#control = { cancelRequested: false, restartNow: false };
    this.#hostJob = null;
    const job: AppUpdateJob = {
      id: crypto.randomBytes(6).toString("hex"),
      app: app.id,
      appName: app.name,
      fromVersion: app.version,
      toVersion: version,
      reuse,
      phase: reuse ? "draining" : "installing",
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
    log.info("app update started", { app: app.id, from: app.version, to: version, reuse });
    void this.#run(job, host, app, image);
    return this.snapshot()!;
  }

  /** Cancels a job that is still installing or draining; false when there is none or it is too late. */
  async cancel(): Promise<boolean> {
    const job = this.#job;
    if (!job || job.finishedAt !== null || !job.cancellable) return false;
    this.#control.cancelRequested = true;
    if (job.phase === "installing") await this.#options.host?.cancel().catch(() => false);
    return true;
  }

  /** Ends the drain now: the switch starts even though requests are still running. */
  restartNow(): boolean {
    if (this.#job?.phase !== "draining" || this.#job.finishedAt !== null) return false;
    this.#control.restartNow = true;
    return true;
  }

  /** Removes an installed version of `app` (not the running one). The web app audits it, with the admin who asked. */
  async removeVersion(app: string, version: string): Promise<void> {
    if (!APP_VERSION.test(version)) throw invalidVersion();
    const host = this.#options.host;
    if (host === null) throw unavailable("The AI server's portal-hostd is not set up.");
    this.#idle();
    await host.remove(app, version).catch((error: unknown) => {
      throw hostRefusal(error);
    });
  }

  /** At gateway shutdown: a running job is recorded as failed (hostd carries on with what it was doing). */
  shutdown(): void {
    const job = this.#job;
    if (!job || job.finishedAt !== null) return;
    this.#finish(job, "failed", GATEWAY_STOPPED);
  }

  /** Refuses while this updater or Gufo's runs a job. */
  #idle(): void {
    if (this.running) throw jobRunning();
    if (this.#options.busy?.()) throw engineRunning();
  }

  async #status(host: AppHost, id: string): Promise<AppStatus> {
    const { apps } = await host.status().catch((error: unknown) => {
      throw error instanceof HostdError && error.code === "no_apps"
        ? unavailable(NO_APPS)
        : unavailable(`The AI server's portal-hostd can't be reached: ${errorMessage(error)}`);
    });
    const app = apps.find((candidate) => candidate.id === id);
    if (!app) throw new HttpError(404, "no_app", `The AI server has no ${id} to update.`);
    return app;
  }

  async #run(job: AppUpdateJob, host: AppHost, app: AppStatus, image: { image: string; tag: string } | null): Promise<void> {
    try {
      await this.#install(job, host, image);
      await drainQueue({
        job,
        queue: this.#options.queue,
        drainMs: this.#options.config.engine.drainMs,
        control: this.#control,
        now: this.#now,
        pollMs: this.#pollMs,
        started: () => this.#phase(job, "draining", "Waiting for running requests to finish", true),
        note: (line) => this.#note(job, line),
      });
      this.#phase(job, "restarting", `Switching ${app.name} to ${job.toVersion}`, false);
      const result = await this.#follow(job, await host.apply(job.app, job.toVersion), host, APPLY_TIMEOUT_MS);
      if (result.phase !== "succeeded") {
        job.rolledBack = result.rolledBack;
        throw new Error(result.error ?? `${app.name} did not come up with the new version.`);
      }
      if (job.finishedAt !== null) return; // shutdown() recorded it
      this.#finish(job, "succeeded", null);
    } catch (error) {
      if (job.finishedAt !== null) return;
      if (error instanceof Cancelled) this.#finish(job, "cancelled", CANCELLED);
      else this.#finish(job, "failed", errorMessage(error));
    } finally {
      this.#options.queue.resume();
      this.#hostJob = null;
    }
  }

  /** hostd installs the version beside the running one, unless it is installed already. */
  async #install(job: AppUpdateJob, host: AppHost, image: { image: string; tag: string } | null): Promise<void> {
    if (job.reuse) return this.#note(job, `Using ${job.toVersion}, installed on the AI server already.`);
    this.#phase(job, "installing", `Installing ${job.appName} ${job.toVersion}`, true);
    const started = await host.install(job.app, image ? { version: job.toVersion, ...image } : { version: job.toVersion }).catch((error: unknown) => {
      throw hostRefusal(error);
    });
    const installed = await this.#follow(job, started, host, INSTALL_TIMEOUT_MS);
    if (installed.phase === "cancelled" || this.#control.cancelRequested) throw new Cancelled();
    if (installed.phase !== "succeeded") throw new Error(installed.error ?? "The install failed.");
  }

  #follow(job: AppUpdateJob, started: AppHostJob, host: AppHost, timeoutMs: number): Promise<AppHostJob> {
    return followHostJob({
      job,
      started,
      current: async () => (await host.status()).job,
      now: this.#now,
      pollMs: this.#pollMs,
      timeoutMs,
      live: (current) => (this.#hostJob = current),
      note: (line) => this.#note(job, line),
    });
  }

  #phase(job: AppUpdateJob, phase: AppUpdatePhase, step: string, cancellable: boolean): void {
    job.phase = phase;
    job.step = step;
    job.cancellable = cancellable;
    this.#note(job, `${step}.`);
  }

  #note(job: AppUpdateJob, line: string): void {
    appendLog(job, [line], LOG_LINES);
  }

  #finish(job: AppUpdateJob, phase: "succeeded" | "failed" | "cancelled", error: string | null): void {
    job.drain = null;
    job.cancellable = false;
    const step = phase === "succeeded" ? "Done" : phase === "cancelled" ? "Cancelled" : job.rolledBack ? "Failed; the previous version runs again" : "Failed";
    const details = { app: job.app, from: job.fromVersion, to: job.toVersion };
    const { db, log } = this.#options;
    finishJob(db, log, "app", job, this.#now(), { phase, error, step }, error === null ? details : { ...details, error, rolledBack: job.rolledBack });
  }
}

/** hostd's own refusals (a running version, one already installed, another job) are the admin's to see; the rest is a fault. */
function hostRefusal(error: unknown): unknown {
  if (!(error instanceof HostdError)) return error;
  if (error.status === 409 || error.status === 404 || error.status === 400) return new HttpError(error.status, error.code, error.message);
  return new HttpError(502, "hostd_failed", `portal-hostd on the AI server: ${error.message}`);
}
