// Makes a version of an agent current from the admin console, newer or older: one job at a time, for all agents (an
// image build is heavy work for the host). A build goes to a staging tag; only an image that reports the version asked
// for gets the workspace tag and becomes current, so a failed or cancelled job (or one over the time limit) leaves the
// current version and its image as they were. A version whose image is on the server already is used as it is, without
// a build or the registry. Running workspaces keep the image they started from.
import crypto from "node:crypto";
import { isVersion, type AgentKind, type AgentUpdateJob, type AgentVersionsOverview, type PortalDb, type WorkspaceInfo } from "@portal/core";
import { describeAgentVersions } from "./agent-overview.ts";
import type { AgentVersions } from "./agent-versions.ts";
import { driverFor } from "../agents/index.ts";
import type { Config } from "../config.ts";
import type { ImageBuilder } from "../docker/image-builder.ts";
import { stagingImage, workspaceImage } from "../docker/image-names.ts";
import type { GitHubReleases } from "./github-releases.ts";
import { HttpError } from "../lib/http-util.ts";
import { errorMessage, type Logger } from "../lib/log.ts";
import type { NpmPackage, NpmRegistry } from "./npm-registry.ts";
import { notesByVersion, ReleaseCache } from "./release-cache.ts";
import { appendLog, finishJob } from "./update-job.ts";
import { agentUnavailable } from "../workspaces/manager.ts";

/** For one job's build and version check: a full rebuild (Debian packages, Chromium, npm) on a small host. */
const BUILD_TIMEOUT_MS = 30 * 60_000;
const LOG_LINES = 200;
const CANCELLED = "Cancelled";
export const GATEWAY_RESTARTED = "The gateway restarted during the update.";

const invalidVersion = (version: string): HttpError => new HttpError(400, "invalid_version", `"${version}" is not a version (like 0.27.4).`);
const updateRunning = (message: string): HttpError => new HttpError(409, "update_running", message);

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
  /** Where release notes come from; none: no notes. */
  github?: GitHubReleases;
  /** Every workspace, for the versions running ones use. */
  workspaces: () => readonly WorkspaceInfo[];
  db: PortalDb;
  log: Logger;
  now?: () => number;
  newId?: () => string;
  buildTimeoutMs?: number;
}

export class AgentUpdater {
  readonly #deps: AgentUpdaterDeps;
  readonly #now: () => number;
  readonly #releases: ReleaseCache<NpmPackage>;
  /** The running job, else the last finished one. */
  #job: AgentUpdateJob | null = null;
  /** An update request still being checked (its image on the server, the registry); it counts as running. */
  #pending: AgentKind | null = null;
  /** Cancels the running job; null once it is past the point where that could still leave everything as it was. */
  #cancel: AbortController | null = null;
  /** The job's run, until it has settled: past its outcome, a failed job still removes its staging image. */
  #running: Promise<void> | null = null;

  constructor(deps: AgentUpdaterDeps) {
    const { registry, github, log, now } = deps;
    this.#deps = deps;
    this.#now = now ?? Date.now;
    this.#releases = new ReleaseCache({ source: (name, etag) => registry.packument(name, etag), notes: notesByVersion, github, log, now });
  }

  /** The enabled agents' versions, releases and images, and the current or last job. */
  async overview(options: { refresh?: boolean } = {}): Promise<AgentVersionsOverview> {
    const { config, versions, builder } = this.#deps;
    const kinds = config.workspace.agents;
    const packages = kinds.map((kind) => driverFor(kind).release.packageName);
    const [releases, images] = await Promise.all([this.#releases.snapshot(packages, options), builder.list()]);
    const workspaces = this.#deps.workspaces();
    return {
      agents: kinds.map((kind) =>
        describeAgentVersions({
          kind,
          current: versions.current(kind),
          defaultVersion: versions.defaultVersion(kind),
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

  /** The running job, else the last finished one; null before the first. A copy: later changes don't show in it. */
  job(): AgentUpdateJob | null {
    return this.#job && { ...this.#job, log: [...this.#job.log] };
  }

  /**
   * Starts an update and returns the job as it starts (building, or verifying when it uses the image already on the
   * server). Rejects before anything starts: `agent_unavailable`, `update_running`, `invalid_version`,
   * `version_not_found`, `registry_unreachable`.
   */
  async startUpdate(request: UpdateRequest): Promise<AgentUpdateJob> {
    const { config, versions, builder, registry, log } = this.#deps;
    const { agent, rebuild } = request;
    const { name, release } = driverFor(agent);
    if (!config.workspace.agents.includes(agent)) throw agentUnavailable(agent);
    const running = this.#job?.finishedAt === null ? this.#job : null;
    if (running) throw updateRunning(`${driverFor(running.agent).name} is being updated to ${running.toVersion}. Wait for it to finish, or cancel it.`);
    // A failed job still removes its staging image, and a retry of the same version would build to that very tag.
    if (this.#running) throw updateRunning("The last update is still cleaning up; try again in a moment.");
    if (this.#pending) throw updateRunning("An agent update is already running. Wait for it to finish, or cancel it.");
    this.#pending = agent;
    try {
      const version = request.version.trim();
      if (!isVersion(version)) throw invalidVersion(version);
      // An image on the server is used as it is, without the registry; any other version must be published.
      const reuse = !rebuild && (await builder.exists(workspaceImage(agent, version)));
      if (!reuse && !(await registry.hasVersion(release.packageName, version))) {
        throw new HttpError(404, "version_not_found", `${name} ${version} is not published (${release.packageName}).`);
      }
      const job: AgentUpdateJob = {
        id: this.#deps.newId?.() ?? crypto.randomUUID(),
        agent,
        fromVersion: versions.current(agent),
        toVersion: version,
        rebuild,
        reuse,
        actorUserId: request.actorUserId,
        startedAt: this.#now(),
        phase: "building",
        step: null,
        log: [],
        finishedAt: null,
        error: null,
      };
      const cancel = new AbortController();
      this.#job = job;
      this.#cancel = cancel;
      log.info("agent update started", { agent, from: job.fromVersion, to: version, rebuild, reuse });
      this.#running = this.#run(job, cancel).finally(() => {
        this.#running = null;
        this.#cancel = null;
      });
      return this.job()!;
    } finally {
      this.#pending = null;
    }
  }

  /** Cancels the running job; false when there is none (or it is already making the image current). */
  cancel(): boolean {
    if (this.#job?.finishedAt !== null || !this.#cancel) return false;
    this.#cancel.abort();
    return true;
  }

  /** Resolves when the running job (if any) has finished, its cleanup included. */
  async settled(): Promise<void> {
    await this.#running;
  }

  /**
   * At gateway shutdown: records a running job as failed at once (the process exits within a second) and abandons its
   * build; its staging image goes at the next start (sweep). A job already making its image current finishes.
   */
  shutdown(): void {
    const job = this.#job;
    if (job?.finishedAt !== null || !this.#cancel) return;
    this.#recordFailure(job, GATEWAY_RESTARTED, false);
    this.#cancel.abort();
  }

  /** Removes what interrupted jobs left behind (ImageBuilder.sweep): at gateway start, and before each build. Never rejects. */
  async sweep(): Promise<void> {
    const { builder, log } = this.#deps;
    try {
      const removed = await builder.sweep();
      if (removed.containers.length + removed.images.length > 0) log.info("removed leftovers of earlier agent updates", { ...removed });
    } catch (error) {
      log.warn("could not remove leftovers of earlier agent updates", { error });
    }
  }

  /**
   * Removes one of an agent's images. Rejects with `invalid_version`, `update_running` (a job is building that agent),
   * `image_current` (new workspaces start from it), and the builder's `not_found` / `image_in_use`.
   */
  async removeImage(agent: AgentKind, version: string): Promise<void> {
    const { versions, builder, log } = this.#deps;
    const { name } = driverFor(agent);
    if (!isVersion(version)) throw invalidVersion(version);
    if (this.#pending === agent || (this.#job?.finishedAt === null && this.#job.agent === agent)) {
      throw updateRunning(`An update of ${name} is running. Wait for it to finish, or cancel it.`);
    }
    if (versions.current(agent) === version) {
      throw new HttpError(409, "image_current", `${name} ${version} is the current version: new workspaces start from this image. Switch to another version first.`);
    }
    const image = workspaceImage(agent, version);
    await builder.remove(image);
    log.info("agent image removed", { agent, version, image });
  }

  /** A job that reuses an image checks and uses the image on the server instead of building one. */
  async #run(job: AgentUpdateJob, cancel: AbortController): Promise<void> {
    const { versions, builder, db, log } = this.#deps;
    const { agent, toVersion: version, fromVersion, rebuild, reuse } = job;
    const { name, release } = driverFor(agent);
    const append = (lines: readonly string[]): void => appendLog(job, lines, LOG_LINES);
    const image = workspaceImage(agent, version);
    const staging = stagingImage(agent, version);
    const timeoutMs = this.#deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
    // In the job, not the request, which must answer at once, and before the time limit starts. A cancel meanwhile
    // takes effect at the build.
    if (!reuse) await this.sweep();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([cancel.signal, deadline]);
    try {
      if (reuse) {
        append([`Using the image already on this server (${image}).`]);
      } else {
        await builder.build(
          { kind: agent, version, versionKey: release.versionKey, image: staging, noCache: rebuild },
          {
            onStep: (step) => {
              if (job.finishedAt === null) job.step = step;
            },
            onLog: append,
          },
          signal,
        );
        signal.throwIfAborted();
      }
      job.phase = "verifying";
      job.step = `${release.cli} --version`;
      const reported = await builder.cliVersion(reuse ? image : staging, release.cli, signal);
      if (reported !== version) throw new Error(`The ${reuse ? "" : "new "}image reports ${name} ${reported ?? "(no version)"}, not ${version}.`);
      append([`${release.cli} --version: ${reported}`]);
      signal.throwIfAborted();
      // From here on the job finishes: the image becomes current.
      this.#cancel = null;
      const replaced = reuse ? null : await builder.promote(staging, image);
      versions.set(agent, version);
      finishJob(db, log, "agent", job, this.#now(), { phase: "succeeded", error: null, step: null }, { agent, from: fromVersion, to: version, rebuild });
      // Only now, best effort: removing a large image can outlast the second a shutting-down gateway has left, and the
      // outcome above must not depend on it. A later sweep removes what stays.
      if (replaced !== null) {
        await builder.removeUntagged(replaced).catch((error: unknown) => log.warn("could not remove the build a rebuild replaced", { image: replaced, error }));
      }
    } catch (error) {
      // Finished already: shutdown() has recorded it.
      if (job.finishedAt === null) {
        const cancelled = cancel.signal.aborted;
        const message = cancelled
          ? CANCELLED
          : deadline.aborted && this.#cancel !== null
            ? `The update took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`
            : errorMessage(error);
        this.#recordFailure(job, message, cancelled);
      }
      // After the record: removing a large image can take a while. A reused version's image is the workspace image
      // itself, and it stays.
      if (!reuse) {
        await builder.discard(staging).catch((discardError: unknown) => log.warn("could not remove a staging image", { image: staging, error: discardError }));
      }
    }
  }

  /** Ends a job that didn't make it: failed (with `message`) or cancelled, audited and logged. */
  #recordFailure(job: AgentUpdateJob, message: string, cancelled: boolean): void {
    const end = { phase: cancelled ? "cancelled" : "failed", error: message, step: null } as const;
    finishJob(this.#deps.db, this.#deps.log, "agent", job, this.#now(), end, { agent: job.agent, version: job.toVersion, error: message });
  }
}
