// Makes a version of an agent harness current from the admin console, newer or older: one job at a time, for all
// agents (an image build is heavy work for the host).
//
//   validate the version
//   → that version's image is on the server already and no rebuild was asked for: use it as it is
//     (going back to an earlier version needs neither a build nor the registry)
//   → otherwise: check the registry has it; then, in the job: clear leftovers of interrupted jobs →
//     build the image (BuildKit's cache makes a known version a matter of seconds; `rebuild` builds
//     without the cache)
//   → check the image really contains that version (`<cli> --version`)
//   → give a new build the workspace tag; make the version current → audit → remove the build a
//     rebuild replaced
//
// A build goes to a staging tag; only a checked image gets the workspace tag and becomes current.
// A failed or cancelled job (or one over the time limit) leaves the current version and its image as
// they were. Running workspaces keep the image they started from; every new start uses the current
// version (WorkspaceManager asks AgentVersions at start time).
//
// The seams (ImageBuilder, NpmRegistry, ReleaseCache, AgentVersions, the clock) are injected, so the
// flow is tested with fakes.
import crypto from "node:crypto";
import { writeAudit, type AgentKind, type AuditAction, type PortalDb } from "@portal/db";
import { describeAgentVersions, type AgentVersionsOverview } from "./agent-overview.ts";
import type { AgentVersions } from "./agent-versions.ts";
import { driverFor } from "./agents/index.ts";
import type { Config } from "./config.ts";
import type { ImageBuilder } from "./image-builder.ts";
import { stagingImage, workspaceImage } from "./image-names.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { NpmRegistry } from "./npm-registry.ts";
import type { ReleaseCache } from "./release-cache.ts";
import { CANCELLED, UpdateJob, type AgentUpdateJob } from "./update-job.ts";
import { isVersion } from "./versions.ts";
import { AgentUnavailableError, type WorkspaceInfo } from "./workspaces.ts";

/**
 * A generous bound for one job's build and version check: a full rebuild (Debian packages, Chromium,
 * npm) on a small host.
 */
const BUILD_TIMEOUT_MS = 30 * 60_000;
/** The error of a job the gateway's shutdown abandoned. */
export const GATEWAY_RESTARTED = "The gateway restarted during the update.";

/** Another update is running (there is one at a time, for all agents). */
export class UpdateRunningError extends Error {
  constructor(message = "An agent update is already running. Wait for it to finish, or cancel it.") {
    super(message);
    this.name = "UpdateRunningError";
  }
}

/** Not a version (like 0.27.4). */
export class InvalidVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVersionError";
  }
}

/** The registry has no such version of the agent's package. */
export class VersionNotFoundError extends Error {
  constructor(name: string, packageName: string, version: string) {
    super(`${name} ${version} is not published (${packageName}).`);
    this.name = "VersionNotFoundError";
  }
}

/** The image's CLI reports another version than the job is for (a failed job's message, not an API error). */
class VersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionMismatchError";
  }
}

/** New workspaces start from this image, so it can't go. */
export class ImageCurrentError extends Error {
  constructor(name: string, version: string) {
    super(`${name} ${version} is the current version: new workspaces start from this image. Switch to another version first.`);
    this.name = "ImageCurrentError";
  }
}

export interface UpdateRequest {
  agent: AgentKind;
  /** An exact version. */
  version: string;
  rebuild: boolean;
  actorUserId: number | null;
}

export interface AgentUpdaterDeps {
  config: Config;
  versions: AgentVersions;
  builder: ImageBuilder;
  registry: NpmRegistry;
  releases: ReleaseCache;
  /** Every workspace, for the versions running ones use. */
  workspaces: () => readonly WorkspaceInfo[];
  db: PortalDb;
  log: Logger;
  now?: () => number;
  newId?: () => string;
  buildTimeoutMs?: number;
}

export class AgentUpdater {
  readonly #config: Config;
  readonly #versions: AgentVersions;
  readonly #builder: ImageBuilder;
  readonly #registry: NpmRegistry;
  readonly #releases: ReleaseCache;
  readonly #workspaces: () => readonly WorkspaceInfo[];
  readonly #db: PortalDb;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #buildTimeoutMs: number;
  /** The running job, else the last finished one. */
  #job: UpdateJob | null = null;
  /** An update request still being checked (its image on the server, the registry); it counts as running. */
  #pending: AgentKind | null = null;
  #cancel: AbortController | null = null;
  /** False once the job is past the point where cancelling could still leave everything as it was. */
  #cancellable = false;
  /** The job's run, until it has settled: past its outcome, a failed job still removes its staging image. */
  #running: Promise<void> | null = null;

  constructor(deps: AgentUpdaterDeps) {
    this.#config = deps.config;
    this.#versions = deps.versions;
    this.#builder = deps.builder;
    this.#registry = deps.registry;
    this.#releases = deps.releases;
    this.#workspaces = deps.workspaces;
    this.#db = deps.db;
    this.#log = deps.log;
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
    this.#buildTimeoutMs = deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
  }

  /** The enabled agents' versions, releases and images, and the current or last job. */
  async overview(options: { refresh?: boolean } = {}): Promise<AgentVersionsOverview> {
    const kinds = this.#config.workspace.agents;
    const packages = kinds.map((kind) => driverFor(kind).release.packageName);
    const [releases, images] = await Promise.all([this.#releases.snapshot(packages, options), this.#builder.list()]);
    const workspaces = this.#workspaces();
    return {
      agents: kinds.map((kind) =>
        describeAgentVersions({
          kind,
          current: this.#versions.current(kind),
          defaultVersion: this.#versions.defaultVersion(kind),
          releases: releases.packages.get(driverFor(kind).release.packageName),
          images,
          workspaces,
        }),
      ),
      job: this.job(),
      registryError: releases.error,
      checkedAt: releases.checkedAt,
    };
  }

  /** The running job, else the last finished one; null before the first. */
  job(): AgentUpdateJob | null {
    return this.#job?.snapshot() ?? null;
  }

  /**
   * Starts an update and returns the job as it starts (building, or verifying when it uses the image
   * already on the server). Rejects before anything starts: AgentUnavailableError, UpdateRunningError,
   * InvalidVersionError, VersionNotFoundError, RegistryError.
   */
  async startUpdate(request: UpdateRequest): Promise<AgentUpdateJob> {
    const { agent } = request;
    if (!this.#config.workspace.agents.includes(agent)) throw new AgentUnavailableError(agent);
    if (this.#busy()) throw this.#runningError();
    this.#pending = agent;
    try {
      const { version, reuse } = await this.#plan(agent, request.version.trim(), request.rebuild);
      const job = new UpdateJob({
        id: this.#newId(),
        agent,
        fromVersion: this.#versions.current(agent),
        version,
        rebuild: request.rebuild,
        reuse,
        actorUserId: request.actorUserId,
        startedAt: this.#now(),
      });
      const cancel = new AbortController();
      this.#job = job;
      this.#cancel = cancel;
      this.#cancellable = true;
      this.#log.info("agent update started", { agent, from: job.snapshot().fromVersion, to: version, rebuild: request.rebuild, reuse });
      this.#running = this.#run(job, cancel).finally(() => {
        this.#running = null;
        this.#cancel = null;
        this.#cancellable = false;
      });
      return job.snapshot();
    } finally {
      this.#pending = null;
    }
  }

  /** Cancels the running job; false when there is none (or it is already making the image current). */
  cancel(): boolean {
    if (!this.#job?.active || !this.#cancel || !this.#cancellable) return false;
    this.#cancel.abort();
    return true;
  }

  /** Resolves when the running job (if any) has finished, its cleanup included. */
  async settled(): Promise<void> {
    await this.#running;
  }

  /**
   * At gateway shutdown: abandons a running job (the engine cancels a build when its connection
   * closes) and records it as failed at once, since the process exits within a second; its staging
   * image goes at the next start (sweep). A job already making its image current records its outcome
   * right away and only then removes the build it replaced, which the next start's sweep finishes if
   * the process exits first.
   */
  shutdown(): void {
    const job = this.#job;
    if (!job?.active || !this.#cancel || !this.#cancellable) return;
    this.#recordFailure(job, GATEWAY_RESTARTED, false);
    this.#cancel.abort();
  }

  /**
   * Removes what interrupted jobs left behind (ImageBuilder.sweep): at gateway start, and in each job
   * that builds, before the build. Failing to is logged, not fatal: it never rejects.
   */
  async sweep(): Promise<void> {
    try {
      const removed = await this.#builder.sweep();
      if (removed.containers.length + removed.images.length > 0) this.#log.info("removed leftovers of earlier agent updates", { ...removed });
    } catch (error) {
      this.#log.warn("could not remove leftovers of earlier agent updates", { error });
    }
  }

  /**
   * Removes one of an agent's images. Rejects with InvalidVersionError, UpdateRunningError (a job is
   * building that agent), ImageCurrentError, and the builder's ImageNotFoundError / ImageInUseError.
   */
  async removeImage(agent: AgentKind, version: string): Promise<void> {
    const { name } = driverFor(agent);
    if (!isVersion(version)) throw new InvalidVersionError(`"${version}" is not a version (like 0.27.4).`);
    if (this.#pending === agent || (this.#job?.active && this.#job.agent === agent)) {
      throw new UpdateRunningError(`An update of ${name} is running. Wait for it to finish, or cancel it.`);
    }
    if (this.#versions.current(agent) === version) throw new ImageCurrentError(name, version);
    const image = workspaceImage(agent, version);
    await this.#builder.remove(image);
    this.#log.info("agent image removed", { agent, version, image });
  }

  /**
   * Until a job's run has settled, not only while it shows as running: a failed job then removes its
   * staging image, and a retry of the same version would build to that very tag.
   */
  #busy(): boolean {
    return this.#pending !== null || this.#running !== null;
  }

  #runningError(): UpdateRunningError {
    const job = this.#job?.active ? this.#job : null;
    if (job) return new UpdateRunningError(`${driverFor(job.agent).name} is being updated to ${job.version}. Wait for it to finish, or cancel it.`);
    if (this.#running) return new UpdateRunningError("The last update is still cleaning up; try again in a moment.");
    return new UpdateRunningError();
  }

  /**
   * The version to install and whether to use its image on the server as it is: then nothing is built, and the
   * registry isn't asked either. Otherwise the version must be published.
   */
  async #plan(agent: AgentKind, version: string, rebuild: boolean): Promise<{ version: string; reuse: boolean }> {
    const { name, release } = driverFor(agent);
    if (!isVersion(version)) throw new InvalidVersionError(`"${version}" is not a version (like 0.27.4).`);
    if (!rebuild && (await this.#builder.exists(workspaceImage(agent, version)))) return { version, reuse: true };
    if (!(await this.#registry.hasVersion(release.packageName, version))) throw new VersionNotFoundError(name, release.packageName, version);
    return { version, reuse: false };
  }

  /** A job that reuses an image checks and uses the image on the server instead of building one. */
  async #run(job: UpdateJob, cancel: AbortController): Promise<void> {
    const { agent, version } = job;
    const { name, release } = driverFor(agent);
    const { fromVersion, rebuild, reuse, actorUserId, startedAt } = job.snapshot();
    const image = workspaceImage(agent, version);
    const staging = stagingImage(agent, version);
    // Leftovers of interrupted jobs (a staging tag, a version-check container) go before the build: in
    // the job, not the request, which must answer at once, and before the time limit starts. sweep()
    // never rejects; a cancel meanwhile takes effect at the build.
    if (!reuse) await this.sweep();
    const deadline = AbortSignal.timeout(this.#buildTimeoutMs);
    const signal = AbortSignal.any([cancel.signal, deadline]);
    try {
      if (reuse) {
        job.appendLog([`Using the image already on this server (${image}).`]);
      } else {
        await this.#builder.build(
          { kind: agent, version, versionKey: release.versionKey, image: staging, noCache: rebuild },
          { onStep: (step) => job.setStep(step), onLog: (lines) => job.appendLog(lines) },
          signal,
        );
        signal.throwIfAborted();
      }
      job.verifying(`${release.cli} --version`);
      const reported = await this.#builder.cliVersion(reuse ? image : staging, release.cli, signal);
      if (reported !== version) throw new VersionMismatchError(`The ${reuse ? "" : "new "}image reports ${name} ${reported ?? "(no version)"}, not ${version}.`);
      job.appendLog([`${release.cli} --version: ${reported}`]);
      signal.throwIfAborted();
      // From here on the job finishes: the image becomes current.
      this.#cancellable = false;
      const replaced = reuse ? null : await this.#builder.promote(staging, image);
      this.#versions.set(agent, version);
      job.succeed(this.#now());
      this.#audit("agent_updated", actorUserId, { agent, from: fromVersion, to: version, rebuild });
      this.#log.info("agent updated", { agent, from: fromVersion, to: version, rebuild, seconds: Math.round((this.#now() - startedAt) / 1000) });
      // Only now the build a rebuild replaced, best effort: removing a large image can outlast the second
      // a shutting-down gateway has left, and the outcome above must not depend on it. One that a
      // workspace still uses (or that a shutdown cut short) is removed by a later sweep.
      if (replaced !== null) {
        await this.#builder.removeUntagged(replaced).catch((error: unknown) => this.#log.warn("could not remove the build a rebuild replaced", { image: replaced, error }));
      }
    } catch (error) {
      // Not active any more: shutdown() has recorded it already.
      if (job.active) {
        const cancelled = cancel.signal.aborted;
        const message = cancelled
          ? CANCELLED
          : deadline.aborted && this.#cancellable
            ? `The update took longer than ${Math.round(this.#buildTimeoutMs / 60_000)} minutes and was stopped.`
            : errorMessage(error);
        this.#recordFailure(job, message, cancelled);
      }
      // After the record: removing a large image can take a while. The image of a reused version is the
      // workspace image itself, and it stays.
      if (!reuse) {
        await this.#builder.discard(staging).catch((discardError: unknown) => this.#log.warn("could not remove a staging image", { image: staging, error: discardError }));
      }
    }
  }

  /** Ends a job that didn't make it: failed (with `message`) or cancelled, audited and logged. */
  #recordFailure(job: UpdateJob, message: string, cancelled: boolean): void {
    const { agent, version, actorUserId } = job.snapshot();
    if (cancelled) job.cancel(this.#now());
    else job.fail(message, this.#now());
    this.#audit("agent_update_failed", actorUserId, { agent, version, error: message });
    this.#log.warn(cancelled ? "agent update cancelled" : "agent update failed", { agent, version, error: message });
  }

  #audit(action: AuditAction, actorUserId: number | null, details: unknown): void {
    try {
      writeAudit(this.#db, { action, actorUserId, details });
      return;
    } catch (error) {
      // The admin may have been deleted while the job ran (the actor is a foreign key): keep the entry.
      if (actorUserId === null) return void this.#log.error("could not write audit entry", { action, error });
    }
    this.#audit(action, null, details);
  }
}
