// WorkspaceManager: the state of every user's workspace container (one per user, shared by all of
// that user's sessions), kept in memory and mirrored to the `workspaces` table. It starts and stops
// containers, waits for the agent to come up, tracks activity and whether the agent is working, stops
// idle workspaces, enforces the running cap, and reconciles with what Docker actually runs.
// Every user has two workspaces, Private and Online (WORKSPACE_KINDS), each with its own files, UID,
// network and container; one of them runs at a time, chosen at start, and the entry follows whichever
// kind runs (or ran last). Online needs ONLINE_WORKSPACES on, the admin's permission (users.online_allowed) and the
// host firewall that fences the Online network in (fence.ts): without it, Online workspaces are refused and stopped.
// A workspace runs one agent at a time (Qwen Code or DeepSeek Harness, chosen at start); what
// differs between agents is behind their drivers (agents/). Each start uses the agent's current
// version, which AgentVersions (agent-versions.ts) knows; a running container keeps its image.
// The decisions themselves (busy, idle, what to stop or evict) are pure functions in policy.ts; the
// files a container mounts are prepared by paths.ts.
//
// When a workspace stops: never while its agent is working. Otherwise when nobody has used it for
// IDLE_TIMEOUT_MINUTES, or soon after the last session using it has ended (sign-out, expiry).
import { eq } from "drizzle-orm";
import {
  countSessionsUsingWorkspace,
  users,
  WORKSPACE_KIND_NAMES,
  workspaces,
  writeAudit,
  type AgentKind,
  type AuditAction,
  type BusyReason,
  type OnlineAccess,
  type PortalDb,
  type Workspace,
  type WorkspaceInfo,
  type WorkspaceKind,
  type WorkspaceStatus,
} from "@portal/core";
import type { AgentVersions } from "../updates/agent-versions.ts";
import { AgentConfigError, driverFor, type AgentDriver, type AgentEndpoint } from "../agents/index.ts";
import type { Config } from "../config.ts";
import { closeEndedSessions, type ConnectionRegistry } from "../proxy/connections.ts";
import { containerName } from "../docker/container-spec.ts";
import type { FenceState } from "./fence.ts";
import type { LlmQueue } from "../service/llm-queue.ts";
import { HttpError } from "../lib/http-util.ts";
import { errorMessage, type Logger } from "../lib/log.ts";
import { singleFlight } from "../lib/single-flight.ts";
import type { SessionLog } from "../monitor/session-log.ts";
import {
  assessActivity,
  averageCores,
  chooseEviction,
  idleMs,
  reapVerdict,
  type ActivityAssessment,
  type AgentState,
  type ReapInput,
} from "./policy.ts";
import { READY_TIMEOUT_MS, waitForReady, type ReadyResult } from "./readiness.ts";
import { WorkspaceImageMissingError, type ContainerRuntime, type ContainerState, type ContainerSummary } from "../docker/runtime.ts";
import { eraseKindFiles, prepareWorkspaceFiles, removeUserData, workspaceOwner } from "./paths.ts";

/** The workspace's data (or, `erasing`, that kind's files) is being deleted: it can't be started meanwhile. */
const beingDeleted = (erasing: WorkspaceKind | null = null): HttpError =>
  new HttpError(409, "deleting", erasing === null ? "This workspace is being deleted." : `The ${WORKSPACE_KIND_NAMES[erasing]} workspace's files are being erased.`);

/**
 * No Online workspace runs on this portal now: ONLINE_WORKSPACES is off, or (`firewall`) the host firewall that keeps
 * the Online network off the LAN and the servers is not loaded (fence.ts).
 */
const onlineDisabled = (firewall = false): HttpError =>
  new HttpError(
    409,
    "online_disabled",
    firewall
      ? "Online workspaces are off: the host firewall that keeps them off the local network is not loaded. Ask your administrator."
      : "Online workspaces are turned off on this portal.",
  );

/** That kind is starting, running or stopping: its files can't be erased now. */
const workspaceRunning = (kind: WorkspaceKind): HttpError =>
  new HttpError(409, "workspace_running", `The ${WORKSPACE_KIND_NAMES[kind]} workspace is running. Stop it before erasing its files.`);

/** The agent asked for is not enabled on this install (WORKSPACE_AGENTS). */
export const agentUnavailable = (agent: AgentKind): HttpError => new HttpError(400, "agent_unavailable", `${driverFor(agent).name} is not available on this portal.`);

/** What a start asks for; both optional (see requestStart). */
export interface StartOptions {
  agent?: AgentKind;
  kind?: WorkspaceKind;
}

/**
 * A start request's outcome: `error` is why it was refused before anything happened. Capacity is usually decided
 * before requestStart returns; a start queued behind a stop in progress decides once that stop is done, and `done`
 * then rejects with `capacity` or `deleting` instead. An Online start whose last fence check (fence.ts) fails
 * rejects with `online_disabled`. `done` settles once the container runs.
 */
export type StartAttempt = { ok: true; done: Promise<WorkspaceInfo> } | { ok: false; error: HttpError };

/** Why a workspace is being stopped, as recorded in stopReason and the audit log. */
export interface StopCause {
  reason: string;
  /** The user who asked for the stop (admin actions); null for the gateway's own decisions. */
  actorUserId?: number | null;
  /** Set when the container died by itself: the stop is then audited as workspace_error. */
  lastError?: string | null;
}

/** Where to send a browser's requests: the agent, its address, and the credential that authenticates the gateway to it. */
export interface Upstream extends AgentEndpoint {
  agent: AgentKind;
  kind: WorkspaceKind;
}

export interface WorkspaceManagerOptions {
  config: Config;
  db: PortalDb;
  runtime: ContainerRuntime;
  /** Which version (and image) of an agent a start uses. */
  versions: Pick<AgentVersions, "selection">;
  llm: LlmQueue;
  connections: ConnectionRegistry;
  log: Logger;
  /**
   * Whether the host firewall that fences the Online network in is loaded (fence.ts: fenceCheck). Online workspaces
   * run only while it says "loaded"; without it, never.
   */
  fence?: () => Promise<FenceState>;
  /** Told each state saved, so each run of a workspace is a session (session-log.ts). */
  sessions?: Pick<SessionLog, "sync">;
  now?: () => number;
}

const LOG_TAIL_LINES = 20;
const REAP_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const SAMPLE_INTERVAL_MS = 15_000;
const FLUSH_INTERVAL_MS = 30_000;
/** How often the fence is checked; the Online workspaces stop within this long of it going. */
const FENCE_INTERVAL_MS = 5_000;
/** WebSocket close code sent to browsers when their workspace stops ("going away"). */
const CLOSE_GOING_AWAY = 1001;
const CLOSE_INTERNAL_ERROR = 1011;

interface Entry {
  userId: number;
  status: WorkspaceStatus;
  ready: boolean;
  containerId: string | null;
  /**
   * A container that should be gone but whose removal failed (a failed stop or start). Reconcile
   * retries the removal and never adopts it.
   */
  leftoverContainerId: string | null;
  /** The agent of the current container, or of the last one; null if it never ran one. */
  agent: AgentKind | null;
  /** The workspace kind of the current container, or of the last one ("private" if it never ran one). */
  kind: WorkspaceKind;
  /** The agent version of the current container's image; null without one, or when unknown. */
  version: string | null;
  ip: string | null;
  port: number | null;
  /** The credential of this container's agent (driver.credentialEnv). */
  credential: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  /** Last activity of any kind: a person using it, or the agent working (drives the idle timeout). */
  lastActivityAt: number | null;
  /** Last thing a person did in it (drives MAX_BUSY_HOURS). */
  lastUserActivityAt: number | null;
  stopReason: string | null;
  lastError: string | null;
  memoryBytes: number | null;
  /** From the agent's status checks. */
  agentState: AgentState;
  /** Average CPU use over the last sampling interval. */
  cpuCores: number | null;
  cpuSample: { cpuSeconds: number; at: number } | null;
  /** The last busy reason seen by the stats refresh, to log when work starts. */
  busyReason: BusyReason;
  stopPending: boolean;
  /** In-flight start, until the container runs (readiness continues in the background). */
  starting: Promise<WorkspaceInfo> | null;
  stopping: Promise<WorkspaceInfo> | null;
  /** In-flight deletion of the user's data; starts are refused meanwhile. */
  deleting: Promise<void> | null;
  /** In-flight erasure of one kind's files; starts of that kind are refused meanwhile. */
  erasing: { kind: WorkspaceKind; done: Promise<void> } | null;
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

/** Nothing known about the agent yet. */
const NO_AGENT: AgentState = Object.freeze({ working: null, answeredAt: null, unknown: false });

/** What an entry no longer has once its container is gone. */
const NO_CONTAINER: Partial<Entry> = {
  ready: false,
  readiness: null,
  containerId: null,
  version: null,
  ip: null,
  port: null,
  credential: null,
  memoryBytes: null,
  agentState: NO_AGENT,
  cpuCores: null,
  cpuSample: null,
  busyReason: null,
  stopPending: false,
};

export class WorkspaceManager {
  readonly #config: Config;
  readonly #db: PortalDb;
  readonly #runtime: ContainerRuntime;
  readonly #versions: Pick<AgentVersions, "selection">;
  readonly #llm: LlmQueue;
  readonly #connections: ConnectionRegistry;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #entries = new Map<number, Entry>();
  readonly #checking = new Set<number>();
  readonly #timers: NodeJS.Timeout[] = [];
  #reaping = false;
  #sampling = false;
  readonly #fenceCheck: () => Promise<FenceState>;
  /** The last fence check's answer; "unknown" until there is one (Online runs only on "loaded"). */
  #fence: FenceState = "unknown";
  readonly #sessions: Pick<SessionLog, "sync"> | null;
  #fenceChecks = 0;
  #fenceApplied = 0;
  #fenceLogged: FenceState | null = null;

  constructor(options: WorkspaceManagerOptions) {
    this.#config = options.config;
    this.#db = options.db;
    this.#runtime = options.runtime;
    this.#versions = options.versions;
    this.#llm = options.llm;
    this.#connections = options.connections;
    this.#log = options.log;
    this.#fenceCheck = options.fence ?? (() => Promise.resolve("unknown"));
    this.#sessions = options.sessions ?? null;
    this.#now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------- lifecycle of the manager

  /** Loads the persisted state and reconciles it with the containers Docker is running. */
  async init(): Promise<void> {
    // Before reconcile: it adopts an Online container only while the fence is loaded.
    await this.#updateFence();
    const now = this.#now();
    const stale: Entry[] = [];
    for (const row of this.#db.select().from(workspaces).all()) {
      const entry = entryFromRow(row);
      if (row.status === "stopped" || row.status === "error") {
        // A stopped workspace's row only names a container whose removal failed (see #persist).
        patch(entry, { containerId: null, leftoverContainerId: row.containerId });
      } else {
        // Reconcile adopts the container if it still runs; otherwise this is how it stays. A stop
        // that was under way is finished instead: that container is removed, not adopted.
        const wasStopping = row.status === "stopping";
        patch(entry, {
          ...NO_CONTAINER,
          status: "stopped",
          stoppedAt: now,
          stopReason: wasStopping ? row.stopReason : "error",
          lastError: wasStopping ? row.lastError : "The workspace container was not running when the gateway started.",
          leftoverContainerId: wasStopping ? row.containerId : null,
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
    every(REAP_INTERVAL_MS, "session sweep", () => {
      const closed = closeEndedSessions(this.#db, this.#connections, this.#now());
      if (closed > 0) this.#log.info("closed the agent connections of ended sessions", { closed });
    });
    every(RECONCILE_INTERVAL_MS, "reconcile", () => this.reconcile());
    every(SAMPLE_INTERVAL_MS, "stats refresh", () => this.refreshSamples());
    every(FLUSH_INTERVAL_MS, "activity flush", () => this.flushActivity());
    every(FENCE_INTERVAL_MS, "firewall check", () => this.checkFence());
  }

  // ---------------------------------------------------------------- the Online fence

  /**
   * Checks the host firewall's fence (fence.ts) now. Unless it is loaded, every Online workspace that is starting or
   * running is stopped (stopReason "online_disabled"), and Online starts are refused until a check finds it again.
   */
  async checkFence(): Promise<FenceState> {
    const state = await this.#updateFence();
    if (state === "loaded" || !this.#config.workspace.onlineEnabled) return state;
    const online = [...this.#entries.values()].filter((entry) => entry.kind === "online" && !entry.stopping && (entry.starting || isActive(entry)));
    await Promise.all(
      online.map((entry) => {
        this.#log.warn("stopping an Online workspace: the host firewall that fences it in is not loaded", { userId: entry.userId, firewall: state });
        return this.#stopEntry(entry, { reason: "online_disabled" });
      }),
    );
    return state;
  }

  /** Asks the fence and remembers the answer (the latest check's, should two overlap); logs each change. */
  async #updateFence(): Promise<FenceState> {
    if (!this.#config.workspace.onlineEnabled) return this.#fence;
    const check = ++this.#fenceChecks;
    let state: FenceState;
    try {
      state = await this.#fenceCheck();
    } catch (error) {
      this.#log.warn("could not check the host firewall", { error });
      state = "unknown";
    }
    if (check < this.#fenceApplied) return state;
    this.#fenceApplied = check;
    this.#fence = state;
    if (state !== this.#fenceLogged) {
      if (state === "loaded") {
        if (this.#fenceLogged !== null) this.#log.info("the host firewall that fences the Online workspaces in is loaded again: they may run");
      } else {
        this.#log.error(
          "the host firewall that fences the Online workspaces in is not loaded: Online workspaces are refused and stopped until it is (sudo systemctl status workspace-portal-firewall)",
          { firewall: state },
        );
      }
      this.#fenceLogged = state;
    }
    return state;
  }

  /** Stops the background tasks and saves pending activity. Containers keep running. */
  shutdown(): void {
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    this.flushActivity();
  }

  // ---------------------------------------------------------------- queries

  info(userId: number, online: OnlineAccess = this.onlineAccess(userId)): WorkspaceInfo {
    const entry = this.#entries.get(userId);
    const connections = this.#connections.count(userId);
    const llmInFlight = this.#llm.inFlightFor(userId);
    if (!entry) {
      return {
        userId,
        status: "stopped",
        agent: null,
        kind: "private",
        online,
        agentVersion: null,
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
    const activity = active ? this.#assess(entry) : null;
    return {
      userId,
      status: entry.status,
      agent: entry.agent,
      kind: entry.kind,
      online,
      agentVersion: active ? entry.version : null,
      ready: entry.ready,
      startedAt: entry.startedAt,
      lastActivityAt: entry.lastActivityAt,
      idleSeconds: activity ? Math.floor(idleMs(activity, this.#now()) / 1000) : null,
      memoryBytes: active ? entry.memoryBytes : null,
      connections,
      llmInFlight,
      busy: activity?.busy ?? false,
      busyReason: activity?.busyReason ?? null,
      stopPending: active && entry.stopPending,
      stopReason: entry.stopReason,
      lastError: entry.lastError,
    };
  }

  /** Every user that has a workspace row. */
  list(): WorkspaceInfo[] {
    // One query for everyone's Online permission, not one per workspace.
    const allowed = new Map(this.#db.select({ id: users.id, onlineAllowed: users.onlineAllowed }).from(users).all().map((row) => [row.id, row.onlineAllowed]));
    return [...this.#entries.keys()]
      .sort((a, b) => a - b)
      .map((userId) => this.info(userId, this.#onlineAccessOf(allowed.get(userId) ?? false)));
  }

  /** WorkspaceInfo.online: the global switch and the host firewall's fence first, then the admin's permission for this user. */
  onlineAccess(userId: number): OnlineAccess {
    if (!this.#onlineOn()) return "off";
    const row = this.#db.select({ onlineAllowed: users.onlineAllowed }).from(users).where(eq(users.id, userId)).get();
    return this.#onlineAccessOf(row?.onlineAllowed ?? false);
  }

  #onlineAccessOf(allowed: boolean): OnlineAccess {
    if (!this.#onlineOn()) return "off";
    return allowed ? "allowed" : "not_allowed";
  }

  /** ONLINE_WORKSPACES is on and the last fence check found the host firewall loaded. */
  #onlineOn(): boolean {
    return this.#config.workspace.onlineEnabled && this.#fence === "loaded";
  }

  /** Why an Online workspace of this user may not run (now), or null when it may. */
  #onlineRefusal(userId: number): HttpError | null {
    if (!this.#config.workspace.onlineEnabled) return onlineDisabled();
    if (this.#fence !== "loaded") return onlineDisabled(true);
    return this.onlineAccess(userId) === "not_allowed" ? new HttpError(403, "online_not_allowed", "Your administrator hasn't allowed you an Online workspace.") : null;
  }

  /** Workspaces holding a container slot (starting or running). */
  runningCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (isActive(entry)) count++;
    return count;
  }

  /**
   * The proxy target of a ready workspace of this kind, or null while it is not ready, or while the user's other
   * kind is what runs: a kind's port only ever reaches that kind's container.
   */
  upstream(userId: number, kind: WorkspaceKind): Upstream | null {
    const entry = this.#entries.get(userId);
    const endpoint = entry && entry.kind === kind && entry.status === "running" && entry.ready ? endpointOf(entry) : null;
    return endpoint && entry?.agent ? { ...endpoint, agent: entry.agent, kind } : null;
  }

  /**
   * The user whose workspace container of this kind has this address (service API caller identity). Only that
   * kind's containers count: each kind's service listener is on its own network and knows nobody from the other.
   */
  userIdForIp(kind: WorkspaceKind, ip: string): number | null {
    for (const entry of this.#entries.values()) {
      if (isActive(entry) && entry.kind === kind && entry.ip === ip) return entry.userId;
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

  /**
   * The workspace's agent did something (an LLM or search request): activity, but not a person.
   * Past MAX_BUSY_HOURS it no longer delays the idle stop (see assessActivity).
   */
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
   * Starts the user's workspace of `kind` with `agent` unless one is already starting or running.
   *   * Kind: one at a time. Asking for the other kind while one runs is refused (`kind_mismatch`); a start without a
   *     kind attaches to whichever runs, and starts Private when none does. Online needs ONLINE_WORKSPACES and the
   *     admin's permission.
   *   * Agent: without one, the agent the user chose in Settings (users.agent) when it is enabled, else the first
   *     enabled one. One at a time too: asking for another one while it runs is refused; a start without an agent
   *     attaches to whatever runs.
   * Refused too while its data (or that kind's files) is being deleted. See StartAttempt for when capacity is decided.
   */
  requestStart(userId: number, options: StartOptions = {}): StartAttempt {
    const { agent, kind: requested } = options;
    const refuse = (status: number, code: string, message: string): StartAttempt => ({ ok: false, error: new HttpError(status, code, message) });
    if (!this.#hasWorkspacePort(userId)) {
      return refuse(409, "no_workspace_port", `User ${userId} has no workspace port: this portal serves workspaces for user ids 1 to ${this.#config.agentPortCount - 1} (AGENT_PORT_COUNT).`);
    }
    const existing = this.#entries.get(userId);
    if (existing?.deleting) return { ok: false, error: beingDeleted() };
    if (existing?.stopping) return { ok: true, done: existing.stopping.then(() => this.start(userId, options)) };
    if (existing && (existing.starting || isActive(existing)) && existing.agent !== null) {
      if (requested !== undefined && requested !== existing.kind) {
        return refuse(409, "kind_mismatch", `Your ${WORKSPACE_KIND_NAMES[existing.kind]} workspace is running. Stop it to start the ${WORKSPACE_KIND_NAMES[requested]} one.`);
      }
      if (agent !== undefined && agent !== existing.agent) {
        return refuse(409, "agent_mismatch", `${driverFor(existing.agent).name} is already running in this workspace. Stop it to switch.`);
      }
      // Someone is using it again: a stop that waited for the agent to finish is off.
      existing.stopPending = false;
      return { ok: true, done: existing.starting ?? Promise.resolve(this.info(userId)) };
    }

    const kind = requested ?? "private";
    if (kind === "online") {
      const refusal = this.#onlineRefusal(userId);
      if (refusal) return { ok: false, error: refusal };
    }
    if (existing?.erasing?.kind === kind) return { ok: false, error: beingDeleted(kind) };
    const chosen = agent ?? this.preferredAgent(userId);
    if (!this.#config.workspace.agents.includes(chosen)) return { ok: false, error: agentUnavailable(chosen) };

    const slot = this.#reserveSlot(userId);
    if (!slot.ok) {
      return refuse(409, "capacity", `All ${this.#config.maxRunning} workspace slots are in use and none has been idle long enough to make room.`);
    }
    const eviction = slot.victim === null ? null : this.stop(slot.victim, "capacity");

    const entry = existing ?? this.#createEntry(userId);
    const now = this.#now();
    patch(entry, {
      ...NO_CONTAINER,
      status: "starting",
      agent: chosen,
      kind,
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

  /** User ids 1 … AGENT_PORT_COUNT - 1 have workspace ports (and UIDs clear of the other kind's); no other id runs one. */
  #hasWorkspacePort(userId: number): boolean {
    return Number.isInteger(userId) && userId >= 1 && userId < this.#config.agentPortCount;
  }

  /** The agent a start without one uses: the user's choice (Settings) if enabled, else the first enabled agent. */
  preferredAgent(userId: number): AgentKind {
    const enabled = this.#config.workspace.agents;
    const chosen = this.#db.select({ agent: users.agent }).from(users).where(eq(users.id, userId)).get()?.agent ?? null;
    return chosen !== null && enabled.includes(chosen) ? chosen : enabled[0]!;
  }

  /**
   * A session has just started using the workspace (sign-in, an admin opening it): if it is starting or running, a
   * stop that waited for the agent to finish is off. Never starts anything; a stopped workspace waits for a Start.
   */
  attach(userId: number): WorkspaceInfo {
    const entry = this.#entries.get(userId);
    if (entry && !entry.stopping && !entry.deleting && (entry.starting || isActive(entry))) entry.stopPending = false;
    return this.info(userId);
  }

  /** Like requestStart, but rejects with the refusal, or with `start_failed`. */
  async start(userId: number, options: StartOptions = {}): Promise<WorkspaceInfo> {
    const attempt = this.requestStart(userId, options);
    if (!attempt.ok) throw attempt.error;
    return attempt.done;
  }

  #reserveSlot(requesterId: number): { ok: true; victim: number | null } | { ok: false } {
    const active = [...this.#entries.values()].filter(isActive);
    if (active.length < this.#config.maxRunning) return { ok: true, victim: null };
    const candidates = active.map((entry) => {
      const { busy, lastActivityAt } = this.#assess(entry);
      return { userId: entry.userId, ready: entry.status === "running" && entry.ready && entry.stopping === null, busy, lastActivityAt };
    });
    const victim = chooseEviction(candidates, requesterId, this.#now());
    return victim === null ? { ok: false } : { ok: true, victim };
  }

  async #launch(entry: Entry, eviction: Promise<WorkspaceInfo> | null): Promise<WorkspaceInfo> {
    const { userId, kind } = entry;
    const agent = entry.agent!;
    const driver = driverFor(agent);
    try {
      if (eviction) {
        // Wait for the evicted container to go before starting another (memory headroom).
        await eviction.catch(() => undefined);
        // A stop that arrived meanwhile: nothing to start.
        if (entry.status !== "starting") return this.info(userId);
      }
      // A container a failed stop left behind (of either kind) goes first.
      await this.#removeLeftover(entry);
      if (entry.status !== "starting") return this.info(userId);
      prepareWorkspaceFiles(this.#config, userId, kind, agent);
      const credential = driver.generateCredential();
      const { version, image } = this.#versions.selection(agent);
      // The fence once more, as late as it gets: an Online container runs only inside it.
      if (kind === "online" && (await this.#updateFence()) !== "loaded") throw onlineDisabled(true);
      if (entry.status !== "starting") return this.info(userId);
      const container = await this.#runtime.startWorkspace(userId, { kind, agent, credential, image });
      // startWorkspace removed every earlier container of this user, a leftover included.
      patch(entry, { containerId: container.id, ip: container.ip, port: container.port, credential, version, leftoverContainerId: null });
      // A stop that arrived meanwhile waits for this start and then removes the container.
      if (entry.status !== "starting") return this.info(userId);
      this.#claimIp(entry);
      this.#persist(entry);
      this.#audit("workspace_started", userId, { agent, version, kind });
      this.#log.info("workspace container started", { userId, kind, agent, version, containerId: container.id, ip: container.ip });
      this.#watchReadiness(entry);
      return this.info(userId);
    } catch (error) {
      if (entry.status !== "starting") return this.info(userId);
      if (error instanceof HttpError && error.code === "online_disabled") {
        // Refused before there was a container: stopped, as a running one would be for the same reason.
        patch(entry, { ...NO_CONTAINER, status: "stopped", stoppedAt: this.#now(), stopReason: error.code, lastError: null });
        this.#persist(entry);
        this.#log.warn("refused an Online workspace start: the host firewall that fences it in is not loaded", { userId });
        this.#connections.closeWorkspace(userId, CLOSE_GOING_AWAY, "workspace stopped");
        throw error;
      }
      const message =
        error instanceof WorkspaceImageMissingError || error instanceof AgentConfigError
          ? error.message
          : `could not start the workspace container: ${errorMessage(error)}`;
      await this.#fail(entry, message);
      throw new HttpError(500, "start_failed", message);
    }
  }

  /**
   * Docker hands a freed address to the next container. Should another workspace still claim it
   * (its container died and nobody noticed yet), it no longer does: service API calls from this
   * address are this workspace's.
   */
  #claimIp(entry: Entry): void {
    if (entry.ip === null) return;
    for (const other of this.#entries.values()) {
      // Addresses are per network, so only a workspace of the same kind can hold this one.
      if (other === entry || other.kind !== entry.kind || other.ip !== entry.ip) continue;
      this.#log.warn("a workspace's address now belongs to another workspace", { userId: other.userId, ip: other.ip, newUserId: entry.userId });
      other.ip = null;
      this.#persist(other);
      this.checkContainer(other.userId);
    }
  }

  #watchReadiness(entry: Entry): void {
    const { userId, containerId } = entry;
    const endpoint = endpointOf(entry);
    if (containerId === null || endpoint === null || entry.agent === null) return;
    const driver = driverFor(entry.agent);
    const abort = new AbortController();
    entry.readiness = abort;
    const startedAt = this.#now();
    // A stop aborts `abort`; a later start replaces the container id.
    const current = (): boolean => !abort.signal.aborted && entry.containerId === containerId && entry.status === "starting";

    void waitForReady({
      probe: () => driver.probeReady(endpoint),
      state: () => this.#runtime.state(containerId),
      signal: abort.signal,
    })
      .then(async (result) => {
        if (!current()) return;
        if (result.ok) {
          // The probe answered: an unknown agent state counts from here.
          patch(entry, { status: "running", ready: true, readiness: null, agentState: { ...NO_AGENT, answeredAt: this.#now() } });
          this.#persist(entry);
          this.#log.info("workspace ready", { userId, seconds: Math.round((this.#now() - startedAt) / 100) / 10 });
          return;
        }
        const tail = await this.#runtime.logsTail(containerId, LOG_TAIL_LINES).catch(() => "");
        if (current()) await this.#fail(entry, withLogs(describeStartupFailure(driver, result), tail));
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
    this.#audit("workspace_error", userId, { error: firstLine(message), kind: entry.kind });
    this.#log.error("workspace failed to start", { userId, kind: entry.kind, error: firstLine(message) });
    this.#connections.closeWorkspace(userId, CLOSE_INTERNAL_ERROR, "workspace failed");
    if (containerId) {
      await this.#runtime.removeContainer(containerId).catch((error: unknown) => {
        this.#log.warn("could not remove failed workspace container", { userId, containerId, error });
        // Unless a new start has begun (it removes the container itself), reconcile retries.
        if (entry.status === "error") {
          entry.leftoverContainerId = containerId;
          this.#persist(entry);
        }
      });
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
    if (!entry || !isActive(entry) || this.#sessionsUsing(userId) > 0) return this.info(userId);
    if (entry.status === "running" && entry.ready) {
      await this.#refreshAgentState(entry);
      // Someone may have signed in again, or the workspace stopped, while the agent was asked.
      if (!isActive(entry) || this.#sessionsUsing(userId) > 0) return this.info(userId);
    }
    if (this.#assess(entry).busy) {
      if (!entry.stopPending) this.#log.info("last session ended while the agent is working; stopping when it is done", { userId });
      entry.stopPending = true;
      return this.info(userId);
    }
    return this.stop(userId, "logout");
  }

  /**
   * Stops the workspace and deletes everything it stored (user deletion). Starts are refused until
   * it is done, a start queued behind the stop included. Rejects with `stop_failed`, deleting nothing,
   * when the container can't be removed.
   */
  deleteData(userId: number): Promise<void> {
    const existing = this.#entries.get(userId);
    if (existing?.deleting) return existing.deleting;
    const entry = existing ?? this.#createEntry(userId);
    const done = this.#deleteEntry(entry, existing === undefined);
    entry.deleting = done;
    const clear = (): void => {
      if (entry.deleting === done) entry.deleting = null;
    };
    done.then(clear, clear);
    return done;
  }

  async #deleteEntry(entry: Entry, created: boolean): Promise<void> {
    const { userId } = entry;
    try {
      await this.#stopEntry(entry, { reason: "deleted" });
      // Also a container an earlier stop failed to remove: its mounts are the data about to go.
      await this.#removeLeftover(entry).catch((error: unknown) => {
        throw new HttpError(500, "stop_failed", `could not stop the workspace container, so its data was not deleted: ${errorMessage(error)}`);
      });
      await removeUserData(this.#config.dataDir, userId);
    } catch (error) {
      if (created) this.#entries.delete(userId);
      throw error;
    }
    this.#entries.delete(userId);
    this.#db.delete(workspaces).where(eq(workspaces.userId, userId)).run();
  }

  /**
   * Empties one kind's home and workspace folders (Admin's "Erase files"), audited `workspace_files_erased` with the
   * kind. Refused (`workspace_running`) while that kind is starting, running or stopping, or while Docker still has a
   * container of that kind for the user (one a failed stop left behind and that can't be removed), and (`deleting`)
   * while the user's data is being deleted; starts of that kind are refused until it is done. The other kind's files
   * are untouched, and it may run meanwhile.
   */
  async eraseFiles(userId: number, kind: WorkspaceKind, actorUserId: number | null = null): Promise<void> {
    const existing = this.#entries.get(userId);
    if (existing?.deleting) throw beingDeleted();
    if (existing?.erasing) {
      if (existing.erasing.kind === kind) return existing.erasing.done;
      await existing.erasing.done.catch(() => undefined);
    }
    const entry = existing ?? this.#createEntry(userId);
    if (entry.kind === kind && (entry.starting || entry.stopping || isActive(entry) || entry.status === "stopping")) {
      throw workspaceRunning(kind);
    }
    const done = (async () => {
      // A container a failed stop left behind may still mount the folders, whichever kind the entry shows now (the
      // other kind's failed start leaves it in place), so it goes first; if it can't, nothing is erased.
      await this.#removeLeftover(entry).catch((error: unknown) => {
        this.#log.warn("could not remove a workspace container left behind by a failed stop; its files are not erased", { userId, kind, error });
        throw workspaceRunning(kind);
      });
      // And Docker itself must have no container of that kind for the user (none of a kind it can't tell, either).
      const containers = await this.#runtime.list();
      if (containers.some((container) => container.userId === userId && (container.kind === kind || container.kind === null))) {
        throw workspaceRunning(kind);
      }
      await eraseKindFiles(this.#config.dataDir, userId, kind, workspaceOwner(this.#config, userId, kind));
    })();
    entry.erasing = { kind, done };
    try {
      await done;
    } finally {
      if (entry.erasing?.done === done) entry.erasing = null;
      // An entry made only to hold `erasing` goes again, unless a start has used it meanwhile.
      if (existing === undefined && entry.startedAt === null && !entry.starting && this.#entries.get(userId) === entry) this.#entries.delete(userId);
    }
    this.#audit("workspace_files_erased", userId, { kind }, actorUserId);
    this.#log.info("workspace files erased", { userId, kind, actorUserId });
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
      // The container may still run: reconcile retries the removal, and never adopts it.
      patch(entry, { ...NO_CONTAINER, status: "error", stoppedAt: this.#now(), lastError: message, leftoverContainerId: containerId });
      this.#persist(entry);
      this.#audit("workspace_error", userId, { reason, error: message, kind: entry.kind }, actorUserId);
      this.#log.error("workspace stop failed", { userId, containerId, error });
      return this.info(userId);
    }

    patch(entry, { ...NO_CONTAINER, status: "stopped", stoppedAt: this.#now(), stopReason: reason, lastError });
    this.#persist(entry);
    if (lastError) this.#audit("workspace_error", userId, { reason, error: firstLine(lastError), kind: entry.kind });
    else if (containerId) this.#audit("workspace_stopped", userId, { reason, kind: entry.kind }, actorUserId);
    this.#log.info("workspace stopped", { userId, kind: entry.kind, reason });
    return this.info(userId);
  }

  /** Removes a container a failed stop or start left behind; rejects if it still can't. */
  async #removeLeftover(entry: Entry): Promise<void> {
    const containerId = entry.leftoverContainerId;
    if (!containerId) return;
    await this.#runtime.stopContainer(containerId);
    if (entry.leftoverContainerId === containerId) {
      entry.leftoverContainerId = null;
      this.#persist(entry);
    }
    this.#log.info("removed a workspace container left behind by a failed stop", { userId: entry.userId, containerId });
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
    // The admin's switch (or ONLINE_WORKSPACES) went off: an Online workspace stops, working or not.
    if (entry.kind === "online") {
      const refusal = this.#onlineRefusal(entry.userId);
      if (refusal) return void (await this.#stopEntry(entry, { reason: refusal.code }));
    }
    let input = this.#reapInput(entry);
    // Nobody uses it, but the agent is still working: it stops once the work is done.
    entry.stopPending = input.sessions === 0 && input.busy;
    if (reapVerdict(input) === "keep") return;
    // About to stop it: ask the agent once more, in case work started since the last check.
    const containerId = entry.containerId;
    await this.#refreshAgentState(entry);
    if (entry.status !== "running" || entry.containerId !== containerId || entry.stopping || entry.starting) return;
    input = this.#reapInput(entry);
    entry.stopPending = input.sessions === 0 && input.busy;
    const verdict = reapVerdict(input);
    if (verdict === "keep") return;
    await this.#stopEntry(entry, { reason: verdict === "released" ? "logout" : "idle" });
  }

  #reapInput(entry: Entry): ReapInput {
    const { busy, lastActivityAt } = this.#assess(entry);
    return { busy, lastActivityAt, now: this.#now(), idleTimeoutMs: this.#config.idleTimeoutMs, sessions: this.#sessionsUsing(entry.userId) };
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

  /**
   * Asks the workspace's agent whether it is working. Without an answer the last one is kept and the
   * state becomes unknown (see agentCountsAsWorking).
   */
  async #refreshAgentState(entry: Entry, options: { updateBusy?: boolean } = {}): Promise<void> {
    const { containerId } = entry;
    const endpoint = endpointOf(entry);
    if (endpoint === null || entry.agent === null) return;
    const driver = driverFor(entry.agent);
    const status = await driver.fetchStatus(endpoint);
    if (entry.containerId !== containerId) return;
    if (status === null) {
      if (!entry.agentState.unknown) this.#log.warn(`${driver.name} did not answer its status check`, { userId: entry.userId });
      entry.agentState = { ...entry.agentState, unknown: true };
    } else {
      entry.agentState = { working: status.working, answeredAt: this.#now(), unknown: false };
      // The agent started or finished something more recently than anything else we saw.
      if (status.idleSinceMs !== null) {
        const agentActive = this.#now() - status.idleSinceMs;
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
    const reason = this.#assess(entry).busyReason;
    if (reason !== null && reason !== entry.busyReason) this.#log.info("agent working", { userId: entry.userId, reason });
    entry.busyReason = reason;
    if (reason !== null) {
      entry.lastActivityAt = this.#now();
      entry.activityDirty = true;
    }
  }

  /**
   * Aligns state with Docker: adopts running workspace containers of users we have rows for,
   * removes any other workspace container, and records containers that are gone.
   */
  readonly reconcile = singleFlight(() => this.#reconcileOnce());

  async #reconcileOnce(): Promise<void> {
    const running = new Set<string>();
    for (const container of await this.#runtime.list()) {
      const entry = container.userId === null ? undefined : this.#entries.get(container.userId);
      if (entry && (entry.starting || entry.stopping || entry.containerId === container.id)) {
        // Being started or stopped right now, or already tracked (exits are handled below).
        if (container.running) running.add(container.id);
        continue;
      }
      if (entry && entry.leftoverContainerId === container.id) {
        await this.#removeLeftover(entry).catch((error: unknown) =>
          this.#log.warn("could not remove a workspace container left behind by a failed stop", { userId: entry.userId, containerId: container.id, error }),
        );
        continue;
      }
      const refusal = container.kind === "online" ? this.#onlineRefusal(container.userId!) : null;
      if (entry && container.running && !isActive(entry) && refusal) {
        await this.#stopRefused(entry, container.id, refusal);
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

  /**
   * An Online container found running that may not run (ONLINE_WORKSPACES is off, or the admin barred the user since):
   * stopped, not adopted, and recorded as stopped for that reason.
   */
  async #stopRefused(entry: Entry, containerId: string, refusal: HttpError): Promise<void> {
    const reason = refusal.code;
    this.#log.info("stopping an Online workspace that may not run", { userId: entry.userId, containerId, reason });
    try {
      await this.#runtime.stopContainer(containerId);
    } catch (error) {
      this.#log.warn("could not stop an Online workspace that may not run; reconcile retries", { userId: entry.userId, containerId, error });
      return;
    }
    patch(entry, { ...NO_CONTAINER, kind: "online", status: "stopped", stoppedAt: this.#now(), stopReason: reason, lastError: null });
    this.#persist(entry);
    this.#audit("workspace_stopped", entry.userId, { reason, kind: "online" });
  }

  /** Tracks a container that was already running (gateway restart); readiness is checked again. */
  async #adopt(entry: Entry, container: ContainerSummary): Promise<boolean> {
    if (!container.ip || container.agent === null || container.kind === null || container.port === null) return false;
    if (!this.#hasWorkspacePort(entry.userId)) {
      // AGENT_PORT_COUNT went down since it started: no port reaches it, and its UID may be the other kind's now.
      this.#log.warn("not adopting a workspace container of a user without a workspace port (AGENT_PORT_COUNT)", { userId: entry.userId, containerId: container.id });
      return false;
    }
    const credential = await this.#runtime.credential(container.id, container.agent).catch(() => null);
    if (!credential) {
      this.#log.warn("cannot adopt workspace container: its credential is unknown", { userId: entry.userId, containerId: container.id });
      if (!entry.starting && !entry.stopping && !isActive(entry)) {
        patch(entry, { lastError: "After a gateway restart the running workspace could not be taken over (its access token was missing), so it was removed. Opening it starts it again." });
        this.#persist(entry);
      }
      return false;
    }
    if (entry.starting || entry.stopping || entry.deleting || isActive(entry)) return false;
    const now = this.#now();
    patch(entry, {
      ...NO_CONTAINER,
      status: "starting",
      agent: container.agent,
      kind: container.kind,
      version: container.version,
      containerId: container.id,
      ip: container.ip,
      port: container.port,
      credential,
      startedAt: entry.startedAt ?? now,
      lastActivityAt: now,
      lastUserActivityAt: now,
      stopReason: null,
      lastError: null,
    });
    this.#claimIp(entry);
    this.#persist(entry);
    this.#log.info("adopted running workspace container", { userId: entry.userId, kind: container.kind, agent: container.agent, containerId: container.id });
    this.#watchReadiness(entry);
    return true;
  }

  // ---------------------------------------------------------------- helpers

  /** Busy, why, and where the idle countdown runs from (policy.ts decides). */
  #assess(entry: Entry): ActivityAssessment {
    return assessActivity(
      {
        agent: entry.agentState,
        llmBusy: this.#llm.pendingFor(entry.userId) > 0,
        cpuCores: entry.cpuCores,
        lastActivityAt: entry.lastActivityAt,
        lastUserActivityAt: entry.lastUserActivityAt,
      },
      this.#now(),
      this.#config.maxBusyMs,
    );
  }

  #sessionsUsing(userId: number): number {
    return countSessionsUsingWorkspace(this.#db, userId, this.#now());
  }

  #createEntry(userId: number): Entry {
    const entry = entryFromRow({
      userId,
      containerId: null,
      containerName: null,
      ip: null,
      kind: "private",
      status: "stopped",
      agent: null,
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
    // A stopped workspace keeps the id of a container whose removal failed, so a restarted gateway
    // removes it too instead of adopting it.
    const containerId = entry.containerId ?? entry.leftoverContainerId;
    const row = {
      containerId,
      containerName: containerId ? containerName(entry.userId, entry.kind) : null,
      ip: entry.ip,
      status: entry.status,
      agent: entry.agent,
      kind: entry.kind,
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
    this.#sessions?.sync(entry);
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
    leftoverContainerId: null,
    agent: row.agent,
    kind: row.kind,
    version: null,
    ip: row.ip,
    port: null,
    credential: null,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    lastActivityAt: row.lastActivityAt,
    lastUserActivityAt: row.lastActivityAt,
    stopReason: row.stopReason,
    lastError: row.lastError,
    memoryBytes: null,
    agentState: NO_AGENT,
    cpuCores: null,
    cpuSample: null,
    busyReason: null,
    stopPending: false,
    starting: null,
    stopping: null,
    deleting: null,
    erasing: null,
    readiness: null,
    activityDirty: false,
  };
}

/** Where the entry's agent listens, with its credential; null without a container to talk to. */
function endpointOf(entry: Entry): AgentEndpoint | null {
  if (!entry.ip || entry.port === null || !entry.credential) return null;
  return { host: entry.ip, port: entry.port, credential: entry.credential };
}

function describeStartupFailure(driver: AgentDriver, result: Exclude<ReadyResult, { ok: true }>): string {
  if (result.reason === "exited") {
    return `${driver.name} exited during startup (exit code ${result.exitCode ?? "unknown"}${result.oomKilled ? ", out of memory" : ""})`;
  }
  return `${driver.name} did not answer within ${READY_TIMEOUT_MS / 1000} s`;
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
