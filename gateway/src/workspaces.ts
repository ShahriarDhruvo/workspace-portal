// WorkspaceManager: the state of every user's workspace container (one per user, shared by all of
// that user's sessions), kept in memory and mirrored to the `workspaces` table. It starts and stops
// containers, waits for Qwen Code to come up, tracks activity and whether the agent is working, stops
// idle workspaces, enforces the running cap, and reconciles with what Docker actually runs.
//
// When a workspace stops: never while its agent is working. Otherwise when nobody has used it for
// IDLE_TIMEOUT_MINUTES, or soon after the last session using it has ended (sign-out, expiry).
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  countSessionsUsingWorkspace,
  workspaces,
  writeAudit,
  type AuditAction,
  type PortalDb,
  type Workspace,
  type WorkspaceStatus,
} from "@portal/db";
import type { Config } from "./config.ts";
import type { ConnectionRegistry } from "./connections.ts";
import { containerName } from "./container-spec.ts";
import type { LlmQueue } from "./llm-queue.ts";
import { errorMessage, type Logger } from "./log.ts";
import { ensureUserDirs, removeUserData, renderGroup, renderPasswd, userPaths, workspaceOwner, writeFileAtomic } from "./paths.ts";
import { averageCores, busyReason, chooseEviction, idleMs, reapVerdict, type ActivitySnapshot, type BusyReason, type ReapVerdict } from "./policy.ts";
import { agentActivity, fetchQwenHealth, generateServerToken, loadAdminQwenConfig, QwenConfigError, renderQwenSettings } from "./qwen.ts";
import { probeQwen, READY_TIMEOUT_MS, waitForReady, type ReadyResult } from "./readiness.ts";
import { WorkspaceImageMissingError, type ContainerRuntime, type ContainerState, type ContainerSummary } from "./runtime.ts";

export interface WorkspaceInfo {
  userId: number;
  status: WorkspaceStatus;
  /** Qwen Code answered its health check and can take prompts. */
  ready: boolean;
  startedAt: number | null;
  lastActivityAt: number | null;
  /** null when not running. */
  idleSeconds: number | null;
  /** From docker stats; null when not running or unknown. */
  memoryBytes: number | null;
  /** Open browser connections (event streams, terminals) right now. */
  connections: { owner: number; admin: number };
  llmInFlight: number;
  /** The agent is working: it is never stopped for inactivity while this is true. */
  busy: boolean;
  /** Why it counts as busy: "task" (the agent reports work), "llm" (a model request), "cpu" (sustained CPU). */
  busyReason: BusyReason;
  /** Nobody uses it any more; it stops by itself once the agent's work is done. */
  stopPending: boolean;
  stopReason: string | null;
  lastError: string | null;
}

export class CapacityError extends Error {
  constructor(maxRunning: number) {
    super(`All ${maxRunning} workspace slots are in use and none has been idle long enough to make room.`);
    this.name = "CapacityError";
  }
}

export class StartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartError";
  }
}

/** A start request's outcome. Capacity is decided synchronously; `done` settles once the container runs. */
export type StartAttempt = { ok: true; done: Promise<WorkspaceInfo> } | { ok: false; error: CapacityError };

/** Why a workspace is being stopped, as recorded in stopReason and the audit log. */
export interface StopCause {
  reason: string;
  /** The user who asked for the stop (admin actions); null for the gateway's own decisions. */
  actorUserId?: number | null;
  /** Set when the container died by itself: the stop is then audited as workspace_error. */
  lastError?: string | null;
}

/** Where to send a browser's requests, and the token that authenticates them to `qwen serve`. */
export interface Upstream {
  host: string;
  port: number;
  token: string;
}

export interface WorkspaceManagerOptions {
  config: Config;
  db: PortalDb;
  runtime: ContainerRuntime;
  llm: LlmQueue;
  connections: ConnectionRegistry;
  log: Logger;
  now?: () => number;
}

const LOG_TAIL_LINES = 20;
const REAP_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const SAMPLE_INTERVAL_MS = 15_000;
const FLUSH_INTERVAL_MS = 30_000;
/** WebSocket close code sent to browsers when their workspace stops ("going away"). */
const CLOSE_GOING_AWAY = 1001;
const CLOSE_INTERNAL_ERROR = 1011;

interface Entry {
  userId: number;
  status: WorkspaceStatus;
  ready: boolean;
  containerId: string | null;
  ip: string | null;
  port: number | null;
  /** The bearer token of this container's `qwen serve`. */
  token: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  /** Last activity of any kind: a person using it, or the agent working (drives the idle timeout). */
  lastActivityAt: number | null;
  /** Last thing a person did in it (drives MAX_BUSY_HOURS). */
  lastUserActivityAt: number | null;
  stopReason: string | null;
  lastError: string | null;
  memoryBytes: number | null;
  /** From the last health check: the agent reports work. null when unknown. */
  agentTask: boolean | null;
  /** Average CPU use over the last sampling interval. */
  cpuCores: number | null;
  cpuSample: { cpuSeconds: number; at: number } | null;
  busy: boolean;
  busyReason: BusyReason;
  stopPending: boolean;
  /** In-flight start, until the container runs (readiness continues in the background). */
  starting: Promise<WorkspaceInfo> | null;
  stopping: Promise<WorkspaceInfo> | null;
  readiness: AbortController | null;
  activityDirty: boolean;
}

/** Holds a container and counts against the cap. */
function isActive(entry: Entry): boolean {
  return entry.status === "starting" || entry.status === "running";
}

/** Type-checked in-place update of an entry. */
function patch(entry: Entry, changes: Partial<Entry>): void {
  Object.assign(entry, changes);
}

/** What an entry no longer has once its container is gone. */
const NO_CONTAINER: Partial<Entry> = {
  ready: false,
  readiness: null,
  containerId: null,
  ip: null,
  port: null,
  token: null,
  memoryBytes: null,
  agentTask: null,
  cpuCores: null,
  cpuSample: null,
  busy: false,
  busyReason: null,
  stopPending: false,
};

export class WorkspaceManager {
  readonly #config: Config;
  readonly #db: PortalDb;
  readonly #runtime: ContainerRuntime;
  readonly #llm: LlmQueue;
  readonly #connections: ConnectionRegistry;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #entries = new Map<number, Entry>();
  readonly #checking = new Set<number>();
  readonly #timers: NodeJS.Timeout[] = [];
  #reconciling: Promise<void> | null = null;
  #reaping = false;
  #sampling = false;

  constructor(options: WorkspaceManagerOptions) {
    this.#config = options.config;
    this.#db = options.db;
    this.#runtime = options.runtime;
    this.#llm = options.llm;
    this.#connections = options.connections;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------- lifecycle of the manager

  /** Loads the persisted state and reconciles it with the containers Docker is running. */
  async init(): Promise<void> {
    const now = this.#now();
    const stale: Entry[] = [];
    for (const row of this.#db.select().from(workspaces).all()) {
      const entry = entryFromRow(row);
      if (row.status !== "stopped" && row.status !== "error") {
        // Reconcile adopts the container if it still runs; otherwise this is how it stays.
        const wasStopping = row.status === "stopping";
        patch(entry, {
          ...NO_CONTAINER,
          status: "stopped",
          stoppedAt: now,
          stopReason: wasStopping ? row.stopReason : "error",
          lastError: wasStopping ? row.lastError : "The workspace container was not running when the gateway started.",
        });
        stale.push(entry);
      }
      this.#entries.set(row.userId, entry);
    }
    await this.reconcile();
    for (const entry of stale) if (entry.status === "stopped") this.#persist(entry);
  }

  startBackgroundTasks(): void {
    const every = (intervalMs: number, name: string, task: () => unknown): void => {
      const timer = setInterval(() => {
        Promise.resolve()
          .then(task)
          .catch((error: unknown) => this.#log.error(`${name} failed`, { error }));
      }, intervalMs);
      timer.unref();
      this.#timers.push(timer);
    };
    every(REAP_INTERVAL_MS, "reaper", () => this.reap());
    every(RECONCILE_INTERVAL_MS, "reconcile", () => this.reconcile());
    every(SAMPLE_INTERVAL_MS, "stats refresh", () => this.refreshSamples());
    every(FLUSH_INTERVAL_MS, "activity flush", () => this.flushActivity());
  }

  /** Stops the background tasks and saves pending activity. Containers keep running. */
  shutdown(): void {
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    this.flushActivity();
  }

  // ---------------------------------------------------------------- queries

  info(userId: number): WorkspaceInfo {
    const entry = this.#entries.get(userId);
    const connections = this.#connections.count(userId);
    const llmInFlight = this.#llm.inFlightFor(userId);
    if (!entry) {
      return {
        userId,
        status: "stopped",
        ready: false,
        startedAt: null,
        lastActivityAt: null,
        idleSeconds: null,
        memoryBytes: null,
        connections,
        llmInFlight,
        busy: false,
        busyReason: null,
        stopPending: false,
        stopReason: null,
        lastError: null,
      };
    }
    const active = isActive(entry);
    const reason = active ? this.#busyReason(entry) : null;
    return {
      userId,
      status: entry.status,
      ready: entry.ready,
      startedAt: entry.startedAt,
      lastActivityAt: entry.lastActivityAt,
      idleSeconds: active ? Math.floor(idleMs(this.#snapshot(entry), this.#now()) / 1000) : null,
      memoryBytes: active ? entry.memoryBytes : null,
      connections,
      llmInFlight,
      busy: reason !== null,
      busyReason: reason,
      stopPending: active && entry.stopPending,
      stopReason: entry.stopReason,
      lastError: entry.lastError,
    };
  }

  /** Every user that has a workspace row. */
  list(): WorkspaceInfo[] {
    return [...this.#entries.keys()].sort((a, b) => a - b).map((userId) => this.info(userId));
  }

  /** Workspaces holding a container slot (starting or running). */
  runningCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (isActive(entry)) count++;
    return count;
  }

  /** The proxy target of a ready workspace, or null while it is not ready. */
  upstream(userId: number): Upstream | null {
    const entry = this.#entries.get(userId);
    if (!entry || entry.status !== "running" || !entry.ready || !entry.ip || entry.port === null || !entry.token) return null;
    return { host: entry.ip, port: entry.port, token: entry.token };
  }

  /** The user whose workspace container has this address (service API caller identity). */
  userIdForIp(ip: string): number | null {
    for (const entry of this.#entries.values()) {
      if (isActive(entry) && entry.ip === ip) return entry.userId;
    }
    return null;
  }

  // ---------------------------------------------------------------- activity

  /** A person did something in the workspace. Ignored unless the workspace holds a container. */
  touch(userId: number): void {
    const entry = this.#entries.get(userId);
    if (!entry || !isActive(entry)) return;
    const now = this.#now();
    entry.lastActivityAt = now;
    entry.lastUserActivityAt = now;
    entry.activityDirty = true;
  }

  /** The workspace's agent did something (an LLM or search request): activity, but not a person. */
  noteAgentActivity(userId: number): void {
    const entry = this.#entries.get(userId);
    if (!entry || !isActive(entry)) return;
    entry.lastActivityAt = this.#now();
    entry.activityDirty = true;
  }

  flushActivity(): void {
    const dirty = [...this.#entries.values()].filter((entry) => entry.activityDirty);
    if (dirty.length === 0) return;
    const now = this.#now();
    try {
      this.#db.transaction((tx) => {
        for (const entry of dirty) {
          tx.update(workspaces)
            .set({ lastActivityAt: entry.lastActivityAt, updatedAt: now })
            .where(eq(workspaces.userId, entry.userId))
            .run();
        }
      });
      for (const entry of dirty) entry.activityDirty = false;
    } catch (error) {
      this.#log.error("could not save workspace activity", { error });
    }
  }

  // ---------------------------------------------------------------- start

  /**
   * Starts a workspace unless it is already starting or running. The capacity decision (including
   * picking a workspace to evict) is made before this returns.
   */
  requestStart(userId: number): StartAttempt {
    const existing = this.#entries.get(userId);
    if (existing?.starting) return { ok: true, done: existing.starting };
    if (existing?.stopping) return { ok: true, done: existing.stopping.then(() => this.start(userId)) };
    if (existing && isActive(existing)) {
      // Someone is using it again: a stop that waited for the agent to finish is off.
      existing.stopPending = false;
      return { ok: true, done: Promise.resolve(this.info(userId)) };
    }

    const slot = this.#reserveSlot(userId);
    if (!slot.ok) return { ok: false, error: new CapacityError(this.#config.maxRunning) };
    const eviction = slot.victim === null ? null : this.stop(slot.victim, "capacity");

    const entry = existing ?? this.#createEntry(userId);
    const now = this.#now();
    patch(entry, {
      ...NO_CONTAINER,
      status: "starting",
      startedAt: now,
      lastActivityAt: now,
      lastUserActivityAt: now,
      stopReason: null,
      lastError: null,
    });
    this.#persist(entry);

    const done = this.#launch(entry, eviction);
    entry.starting = done;
    // Also marks `done` as handled: failures are recorded on the workspace for callers that don't wait.
    const clear = (): void => {
      if (entry.starting === done) entry.starting = null;
    };
    done.then(clear, clear);
    return { ok: true, done };
  }

  /** Like requestStart, but rejects with CapacityError or StartError. */
  async start(userId: number): Promise<WorkspaceInfo> {
    const attempt = this.requestStart(userId);
    if (!attempt.ok) throw attempt.error;
    return attempt.done;
  }

  #reserveSlot(requesterId: number): { ok: true; victim: number | null } | { ok: false } {
    const active = [...this.#entries.values()].filter(isActive);
    if (active.length < this.#config.maxRunning) return { ok: true, victim: null };
    const candidates = active.map((entry) => ({
      userId: entry.userId,
      ready: entry.status === "running" && entry.ready && entry.stopping === null,
      ...this.#snapshot(entry),
    }));
    const victim = chooseEviction(candidates, requesterId, this.#now());
    return victim === null ? { ok: false } : { ok: true, victim };
  }

  async #launch(entry: Entry, eviction: Promise<WorkspaceInfo> | null): Promise<WorkspaceInfo> {
    const { userId } = entry;
    try {
      // Wait for the evicted container to go before starting another (memory headroom).
      if (eviction) await eviction.catch(() => undefined);
      this.#prepareFiles(userId);
      const token = generateServerToken();
      const container = await this.#runtime.startWorkspace(userId, { token });
      patch(entry, { containerId: container.id, ip: container.ip, port: container.port, token });
      // A stop that arrived meanwhile waits for this start and then removes the container.
      if (entry.status !== "starting") return this.info(userId);
      this.#persist(entry);
      this.#audit("workspace_started", userId);
      this.#log.info("workspace container started", { userId, containerId: container.id, ip: container.ip });
      this.#watchReadiness(entry);
      return this.info(userId);
    } catch (error) {
      if (entry.status !== "starting") return this.info(userId);
      const message =
        error instanceof WorkspaceImageMissingError || error instanceof QwenConfigError
          ? error.message
          : `could not start the workspace container: ${errorMessage(error)}`;
      await this.#fail(entry, message);
      throw new StartError(message);
    }
  }

  /**
   * The user's directories, owned by the workspace's own UID, and the read-only files mounted into
   * the container: Qwen Code system settings (the admin's, with the portal's keys forced) and
   * passwd/group naming that UID. Rendered at every start, so changed settings apply on restart.
   */
  #prepareFiles(userId: number): void {
    const paths = userPaths(this.#config.dataDir, userId);
    const owner = workspaceOwner(this.#config.workspace.uidBase, userId);
    const rendered = renderQwenSettings({
      admin: loadAdminQwenConfig(this.#config.qwenConfigDir),
      serviceBaseUrl: `http://${this.#config.workspace.gatewayIp}:${this.#config.servicePort}`,
      model: this.#config.llm.model,
      browser: this.#config.workspace.browser,
    });
    ensureUserDirs(paths, owner);
    writeFileAtomic(path.join(paths.qwenSettings, "settings.json"), `${JSON.stringify(rendered.settings, null, 2)}\n`);
    writeFileAtomic(path.join(paths.qwenSettings, "system-defaults.json"), `${JSON.stringify(rendered.systemDefaults, null, 2)}\n`);
    writeFileAtomic(paths.passwd, renderPasswd(owner));
    writeFileAtomic(paths.group, renderGroup(owner));
  }

  #watchReadiness(entry: Entry): void {
    const { userId, containerId, ip, port, token } = entry;
    if (containerId === null || ip === null || port === null || token === null) return;
    const abort = new AbortController();
    entry.readiness = abort;
    const startedAt = this.#now();
    // A stop aborts `abort`; a later start replaces the container id.
    const current = (): boolean => !abort.signal.aborted && entry.containerId === containerId && entry.status === "starting";

    void waitForReady({
      probe: () => probeQwen(ip, port, token),
      state: () => this.#runtime.state(containerId),
      signal: abort.signal,
    })
      .then(async (result) => {
        if (!current()) return;
        if (result.ok) {
          patch(entry, { status: "running", ready: true, readiness: null });
          this.#persist(entry);
          this.#log.info("workspace ready", { userId, seconds: Math.round((this.#now() - startedAt) / 100) / 10 });
          return;
        }
        const tail = await this.#runtime.logsTail(containerId, LOG_TAIL_LINES).catch(() => "");
        if (current()) await this.#fail(entry, withLogs(describeStartupFailure(result), tail));
      })
      .catch((error: unknown) => this.#log.error("readiness check failed", { userId, error }));
  }

  /** Marks a start as failed and removes its container. The workspace stays "error" until started again. */
  async #fail(entry: Entry, message: string): Promise<void> {
    const { userId, containerId } = entry;
    entry.readiness?.abort();
    patch(entry, {
      ...NO_CONTAINER,
      status: "error",
      stoppedAt: this.#now(),
      stopReason: "error",
      lastError: message,
    });
    this.#persist(entry);
    this.#audit("workspace_error", userId, { error: firstLine(message) });
    this.#log.error("workspace failed to start", { userId, error: firstLine(message) });
    this.#connections.closeWorkspace(userId, CLOSE_INTERNAL_ERROR, "workspace failed");
    if (containerId) {
      await this.#runtime
        .removeContainer(containerId)
        .catch((error: unknown) => this.#log.warn("could not remove failed workspace container", { userId, containerId, error }));
    }
  }

  // ---------------------------------------------------------------- stop

  stop(userId: number, reason: string, actorUserId: number | null = null): Promise<WorkspaceInfo> {
    const entry = this.#entries.get(userId);
    return entry ? this.#stopEntry(entry, { reason, actorUserId }) : Promise.resolve(this.info(userId));
  }

  /**
   * The last session using the workspace may have ended (logout, admin exit, session deletion): stop
   * it if no session uses it any more. If the agent is still working it is left to finish, and the
   * reaper stops it once the work is done ("stopPending").
   */
  async release(userId: number): Promise<WorkspaceInfo> {
    const entry = this.#entries.get(userId);
    if (!entry || !isActive(entry)) return this.info(userId);
    if (countSessionsUsingWorkspace(this.#db, userId, this.#now()) > 0) return this.info(userId);
    if (entry.status === "running" && entry.ready) await this.#refreshAgentState(entry);
    if (this.#busyReason(entry) !== null) {
      if (!entry.stopPending) this.#log.info("last session ended while the agent is working; stopping when it is done", { userId });
      entry.stopPending = true;
      return this.info(userId);
    }
    return this.stop(userId, "logout");
  }

  /** Stops the workspace and deletes everything it stored (user deletion). */
  async deleteData(userId: number): Promise<void> {
    await this.stop(userId, "deleted");
    removeUserData(userPaths(this.#config.dataDir, userId));
    this.#entries.delete(userId);
    this.#db.delete(workspaces).where(eq(workspaces.userId, userId)).run();
  }

  #stopEntry(entry: Entry, cause: StopCause): Promise<WorkspaceInfo> {
    if (entry.stopping) return entry.stopping;
    if (!entry.starting && !isActive(entry)) return Promise.resolve(this.info(entry.userId));
    const done = this.#halt(entry, cause);
    entry.stopping = done;
    const clear = (): void => {
      if (entry.stopping === done) entry.stopping = null;
    };
    done.then(clear, clear);
    return done;
  }

  async #halt(entry: Entry, cause: StopCause): Promise<WorkspaceInfo> {
    const { userId } = entry;
    const { reason, actorUserId = null, lastError = null } = cause;
    const pendingStart = entry.starting;
    entry.readiness?.abort();
    patch(entry, { status: "stopping", ready: false, readiness: null, stopReason: reason });
    this.#persist(entry);
    this.#connections.closeWorkspace(userId, CLOSE_GOING_AWAY, "workspace stopped");
    if (pendingStart) await pendingStart.catch(() => undefined);

    const containerId = entry.containerId;
    try {
      if (containerId) await this.#runtime.stopContainer(containerId);
    } catch (error) {
      const message = `could not stop the workspace container: ${errorMessage(error)}`;
      patch(entry, { ...NO_CONTAINER, status: "error", stoppedAt: this.#now(), lastError: message });
      this.#persist(entry);
      this.#audit("workspace_error", userId, { reason, error: message }, actorUserId);
      this.#log.error("workspace stop failed", { userId, containerId, error });
      return this.info(userId);
    }

    patch(entry, { ...NO_CONTAINER, status: "stopped", stoppedAt: this.#now(), stopReason: reason, lastError });
    this.#persist(entry);
    if (lastError) this.#audit("workspace_error", userId, { reason, error: firstLine(lastError) });
    else if (containerId) this.#audit("workspace_stopped", userId, { reason }, actorUserId);
    this.#log.info("workspace stopped", { userId, reason });
    return this.info(userId);
  }

  /** Checks a running workspace's container (after the proxy failed to reach it) and records an exit. */
  checkContainer(userId: number): void {
    const entry = this.#entries.get(userId);
    if (!entry?.containerId || entry.status !== "running" || this.#checking.has(userId)) return;
    this.#checking.add(userId);
    void this.#handleExit(entry, entry.containerId)
      .catch((error: unknown) => this.#log.warn("container check failed", { userId, error }))
      .finally(() => this.#checking.delete(userId));
  }

  /** A running workspace's container stopped by itself: record why and clean up. */
  async #handleExit(entry: Entry, containerId: string): Promise<void> {
    const [state, tail] = await Promise.all([
      this.#runtime.state(containerId),
      this.#runtime.logsTail(containerId, LOG_TAIL_LINES).catch(() => ""),
    ]);
    if (state.running) return;
    if (entry.containerId !== containerId || entry.status !== "running" || entry.starting || entry.stopping) return;
    await this.#stopEntry(entry, { reason: "error", lastError: withLogs(describeExit(state), tail) });
  }

  // ---------------------------------------------------------------- background tasks

  /** Stops workspaces nobody uses any more, or that have been idle for IDLE_TIMEOUT_MINUTES. */
  async reap(): Promise<void> {
    if (this.#reaping) return;
    this.#reaping = true;
    try {
      const running = [...this.#entries.values()].filter(
        (entry) => entry.status === "running" && entry.ready && !entry.starting && !entry.stopping,
      );
      await Promise.all(running.map((entry) => this.#reapOne(entry)));
    } finally {
      this.#reaping = false;
    }
  }

  async #reapOne(entry: Entry): Promise<void> {
    if (this.#verdict(entry) === "keep") return;
    // About to stop it: ask the agent once more, in case work started since the last check.
    const containerId = entry.containerId;
    await this.#refreshAgentState(entry);
    if (entry.status !== "running" || entry.containerId !== containerId || entry.stopping || entry.starting) return;
    const verdict = this.#verdict(entry);
    if (verdict === "keep") return;
    await this.#stopEntry(entry, { reason: verdict === "released" ? "logout" : "idle" });
  }

  #verdict(entry: Entry): ReapVerdict {
    const now = this.#now();
    const sessions = countSessionsUsingWorkspace(this.#db, entry.userId, now);
    const snapshot = this.#snapshot(entry);
    // Nobody uses it, but the agent is still working: it stops once the work is done.
    entry.stopPending = sessions === 0 && snapshot.busy;
    return reapVerdict({ ...snapshot, now, idleTimeoutMs: this.#config.idleTimeoutMs, sessions });
  }

  /**
   * Every 15 s: memory and CPU from docker stats, whether the agent is working from Qwen Code's
   * health endpoint, and containers that exited. Work counts as activity, so the idle countdown
   * only starts once the agent is done.
   */
  async refreshSamples(): Promise<void> {
    if (this.#sampling) return;
    this.#sampling = true;
    try {
      const running = [...this.#entries.values()].filter((entry) => entry.status === "running" && !entry.stopping);
      await Promise.all(
        running.map(async (entry) => {
          const containerId = entry.containerId;
          if (!containerId) return;
          // Both signals are gathered first and busy is decided once, from this window's CPU average.
          const [sample] = await Promise.all([
            this.#runtime.sample(containerId).catch((error: unknown) => {
              this.#log.warn("docker stats failed", { userId: entry.userId, error });
              return null;
            }),
            entry.ready ? this.#refreshAgentState(entry, { updateBusy: false }) : Promise.resolve(),
          ]);
          if (entry.containerId !== containerId) return;
          if (sample && !sample.running) return void (await this.#handleExit(entry, containerId));
          if (sample) {
            entry.memoryBytes = sample.memoryBytes;
            if (sample.cpuSeconds !== null) {
              const current = { cpuSeconds: sample.cpuSeconds, at: this.#now() };
              entry.cpuCores = averageCores(entry.cpuSample, current);
              entry.cpuSample = current;
            }
          }
          this.#updateBusy(entry);
        }),
      );
    } finally {
      this.#sampling = false;
    }
  }

  /** Asks the workspace's Qwen Code whether the agent is working. Unknown when it does not answer. */
  async #refreshAgentState(entry: Entry, options: { updateBusy?: boolean } = {}): Promise<void> {
    const { ip, port, token, containerId } = entry;
    if (!ip || port === null || !token) return;
    const health = await fetchQwenHealth(ip, port, token);
    if (entry.containerId !== containerId) return;
    if (health === null) {
      entry.agentTask = null;
    } else {
      const activity = agentActivity(health, this.#config.idleTimeoutMs);
      if (activity.abandoned && entry.agentTask !== false) {
        this.#log.info("the agent only waits for an answer nobody is there to give; not counting it as work", { userId: entry.userId });
      }
      entry.agentTask = activity.working && !activity.abandoned;
      // The agent started or finished something more recently than anything else we saw.
      if (health.idleSinceMs !== null) {
        const agentActive = this.#now() - health.idleSinceMs;
        if (entry.lastActivityAt === null || agentActive > entry.lastActivityAt) {
          entry.lastActivityAt = agentActive;
          entry.activityDirty = true;
        }
      }
    }
    if (options.updateBusy !== false) this.#updateBusy(entry);
  }

  /** Recomputes busy from the latest signals; while busy, the workspace counts as active. */
  #updateBusy(entry: Entry): void {
    const reason = this.#busyReason(entry);
    if (reason !== null && reason !== entry.busyReason) this.#log.info("agent working", { userId: entry.userId, reason });
    patch(entry, { busy: reason !== null, busyReason: reason });
    if (reason !== null) {
      entry.lastActivityAt = this.#now();
      entry.activityDirty = true;
    }
  }

  #busyReason(entry: Entry): BusyReason {
    const now = this.#now();
    const { maxBusyMs } = this.#config;
    // Safety net for stuck agents: work stops counting this long after a person last did anything.
    if (maxBusyMs > 0 && entry.lastUserActivityAt !== null && now - entry.lastUserActivityAt > maxBusyMs) return null;
    return busyReason({
      agentTask: entry.agentTask,
      llmBusy: this.#llm.pendingFor(entry.userId) > 0,
      cpuCores: entry.cpuCores,
    });
  }

  /**
   * Aligns state with Docker: adopts running workspace containers of users we have rows for,
   * removes any other workspace container, and records containers that are gone.
   */
  reconcile(): Promise<void> {
    this.#reconciling ??= this.#reconcileOnce().finally(() => {
      this.#reconciling = null;
    });
    return this.#reconciling;
  }

  async #reconcileOnce(): Promise<void> {
    const running = new Set<string>();
    for (const container of await this.#runtime.list()) {
      const entry = container.userId === null ? undefined : this.#entries.get(container.userId);
      if (entry && (entry.starting || entry.stopping || entry.containerId === container.id)) {
        // Being started or stopped right now, or already tracked (exits are handled below).
        if (container.running) running.add(container.id);
        continue;
      }
      if (entry && container.running && !isActive(entry) && (await this.#adopt(entry, container))) {
        running.add(container.id);
        continue;
      }
      this.#log.info("removing workspace container nobody owns", { containerId: container.id, userId: container.userId });
      await this.#runtime
        .removeContainer(container.id)
        .catch((error: unknown) => this.#log.warn("could not remove workspace container", { containerId: container.id, error }));
    }
    for (const entry of [...this.#entries.values()]) {
      const { containerId } = entry;
      if (entry.status === "running" && containerId && !entry.stopping && !running.has(containerId)) {
        await this.#handleExit(entry, containerId);
      }
    }
  }

  /** Tracks a container that was already running (gateway restart); readiness is checked again. */
  async #adopt(entry: Entry, container: ContainerSummary): Promise<boolean> {
    if (!container.ip) return false;
    const token = await this.#runtime.serverToken(container.id).catch(() => null);
    if (!token) {
      this.#log.warn("cannot adopt workspace container: its token is unknown", { userId: entry.userId, containerId: container.id });
      if (!entry.starting && !entry.stopping && !isActive(entry)) {
        patch(entry, { lastError: "After a gateway restart the running workspace could not be taken over (its access token was missing), so it was removed. Opening it starts it again." });
        this.#persist(entry);
      }
      return false;
    }
    if (entry.starting || entry.stopping || isActive(entry)) return false;
    const now = this.#now();
    patch(entry, {
      ...NO_CONTAINER,
      status: "starting",
      containerId: container.id,
      ip: container.ip,
      port: container.port,
      token,
      startedAt: entry.startedAt ?? now,
      lastActivityAt: now,
      lastUserActivityAt: now,
      stopReason: null,
      lastError: null,
    });
    this.#persist(entry);
    this.#log.info("adopted running workspace container", { userId: entry.userId, containerId: container.id });
    this.#watchReadiness(entry);
    return true;
  }

  // ---------------------------------------------------------------- helpers

  #snapshot(entry: Entry): ActivitySnapshot {
    return { lastActivityAt: entry.lastActivityAt, busy: this.#busyReason(entry) !== null };
  }

  #createEntry(userId: number): Entry {
    const entry = entryFromRow({
      userId,
      containerId: null,
      containerName: null,
      ip: null,
      status: "stopped",
      startedAt: null,
      stoppedAt: null,
      lastActivityAt: null,
      stopReason: null,
      lastError: null,
      updatedAt: this.#now(),
    });
    this.#entries.set(userId, entry);
    return entry;
  }

  #persist(entry: Entry): void {
    const row = {
      containerId: entry.containerId,
      containerName: entry.containerId ? containerName(entry.userId) : null,
      ip: entry.ip,
      status: entry.status,
      startedAt: entry.startedAt,
      stoppedAt: entry.stoppedAt,
      lastActivityAt: entry.lastActivityAt,
      stopReason: entry.stopReason,
      lastError: entry.lastError,
      updatedAt: this.#now(),
    };
    try {
      this.#db
        .insert(workspaces)
        .values({ userId: entry.userId, ...row })
        .onConflictDoUpdate({ target: workspaces.userId, set: row })
        .run();
      entry.activityDirty = false;
    } catch (error) {
      this.#log.error("could not save workspace state", { userId: entry.userId, error });
    }
  }

  #audit(action: AuditAction, userId: number, details?: unknown, actorUserId: number | null = null): void {
    try {
      writeAudit(this.#db, { action, actorUserId, targetUserId: userId, details });
    } catch (error) {
      this.#log.error("could not write audit entry", { action, userId, error });
    }
  }
}

function entryFromRow(row: Workspace): Entry {
  return {
    userId: row.userId,
    status: row.status,
    ready: false,
    containerId: row.containerId,
    ip: row.ip,
    port: null,
    token: null,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    lastActivityAt: row.lastActivityAt,
    lastUserActivityAt: row.lastActivityAt,
    stopReason: row.stopReason,
    lastError: row.lastError,
    memoryBytes: null,
    agentTask: null,
    cpuCores: null,
    cpuSample: null,
    busy: false,
    busyReason: null,
    stopPending: false,
    starting: null,
    stopping: null,
    readiness: null,
    activityDirty: false,
  };
}

function describeStartupFailure(result: Exclude<ReadyResult, { ok: true }>): string {
  if (result.reason === "exited") {
    return `Qwen Code exited during startup (exit code ${result.exitCode ?? "unknown"}${result.oomKilled ? ", out of memory" : ""})`;
  }
  return `Qwen Code did not answer within ${READY_TIMEOUT_MS / 1000} s`;
}

function describeExit(state: Extract<ContainerState, { running: false }>): string {
  if (state.exitCode === null) return "the workspace container disappeared";
  return `the workspace container exited unexpectedly (exit code ${state.exitCode}${state.oomKilled ? ", out of memory" : ""})`;
}

function withLogs(message: string, logs: string): string {
  const tail = logs.trimEnd();
  return tail ? `${message}\n${tail}` : message;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}
