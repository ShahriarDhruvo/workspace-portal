// WorkspaceManager: every user's workspaces, kept in memory and mirrored to the `workspaces` table. A user has a
// workspace for every agent and kind (WORKSPACE_REFS), each with files, a UID, a container and ports that are no
// other's, and one container at a time: the entry follows whichever of the user's workspaces runs (or ran last),
// with the agent version chosen at its start. Online needs ONLINE_WORKSPACES on, the admin's permission
// (users.online_allowed) and the host firewall that fences the Online network in (fence.ts): without it, Online
// workspaces are refused and stopped. The decisions (busy, idle, what to stop or evict) are pure functions in
// policy.ts.
//
// When a workspace stops: never while its agent is working. Otherwise when nobody has used it for
// IDLE_TIMEOUT_MINUTES, or soon after the last session using it has ended (sign-out, expiry).
import { eq } from "drizzle-orm";
import {
  countSessionsUsingWorkspace,
  hasWorkspacePorts,
  sameWorkspace,
  users,
  workspaceName,
  workspaceOf,
  workspaces,
  writeAudit,
  type AgentKind,
  type AuditAction,
  type BusyReason,
  type OnlineAccess,
  type PortalDb,
  type WorkspaceInfo,
  type WorkspaceKind,
  type WorkspaceRef,
  type WorkspaceStatus,
} from "@portal/core";
import type { AgentVersions } from "../updates/agent-versions.ts";
import { AgentConfigError, driverFor, type AgentDriver, type AgentEndpoint } from "@portal/harnesses";
import type { Config } from "../config.ts";
import { closeEndedSessions, type ConnectionRegistry } from "../proxy/connections.ts";
import { containerName, type FenceState } from "@portal/container";
import type { LlmQueue } from "../service/llm-queue.ts";
import { HttpError } from "../lib/http-util.ts";
import { errorMessage, type Logger } from "../lib/log.ts";
import { singleFlight } from "../lib/single-flight.ts";
import type { SessionLog } from "../monitor/session-log.ts";
import { assessActivity, averageCores, chooseEviction, idleMs, reapVerdict, type ActivityAssessment, type AgentState, type ReapVerdict } from "./policy.ts";
import { READY_TIMEOUT_MS, waitForReady, type ReadyResult } from "./readiness.ts";
import { WorkspaceImageMissingError, type ContainerRuntime, type ContainerState, type ContainerSummary } from "../docker/runtime.ts";
import { eraseWorkspaceFiles, prepareWorkspaceFiles, removeUserData, workspaceOwner } from "./paths.ts";

/** The user's data (or, `erasing`, that workspace's files) is being deleted: it can't be started meanwhile. */
const beingDeleted = (erasing: WorkspaceRef | null = null): HttpError =>
  new HttpError(409, "deleting", erasing === null ? "This workspace is being deleted." : `The ${workspaceName(erasing)} workspace's files are being erased.`);

/** `firewall`: the host firewall's fence is not loaded (fence.ts); otherwise ONLINE_WORKSPACES is off. */
const onlineDisabled = (firewall = false): HttpError =>
  new HttpError(
    409,
    "online_disabled",
    firewall
      ? "Online workspaces are off: the host firewall that keeps them off the local network is not loaded. Ask your administrator."
      : "Online workspaces are turned off on this portal.",
  );

const workspaceRunning = (ref: WorkspaceRef): HttpError =>
  new HttpError(409, "workspace_running", `The ${workspaceName(ref)} workspace is running. Stop it before erasing its files.`);

/** The agent asked for is not enabled on this install (WORKSPACE_AGENTS). */
export const agentUnavailable = (agent: AgentKind): HttpError => new HttpError(400, "agent_unavailable", `${driverFor(agent).name} is not available on this portal.`);

interface StartOptions {
  agent?: AgentKind;
  kind?: WorkspaceKind;
}

/**
 * A start request's outcome: `error` is why it was refused before anything happened. Capacity is usually decided
 * before requestStart returns; a start queued behind a stop in progress decides once that stop is done, and `done`
 * then rejects with `capacity` or `deleting` instead. An Online start whose last fence check (fence.ts) fails
 * rejects with `online_disabled`. `done` settles once the container runs.
 */
type StartAttempt = { ok: true; done: Promise<WorkspaceInfo> } | { ok: false; error: HttpError };

/** Where to send a browser's requests: the workspace, its agent's address, and the credential that authenticates the gateway to it. */
export interface Upstream extends AgentEndpoint, WorkspaceRef {}

interface WorkspaceManagerOptions {
  config: Config;
  db: PortalDb;
  runtime: ContainerRuntime;
  /** Which version (and image) of an agent a start uses. */
  versions: Pick<AgentVersions, "selection">;
  llm: LlmQueue;
  connections: ConnectionRegistry;
  log: Logger;
  /** Whether the host firewall's fence is loaded (fence.ts: fenceCheck). Online workspaces run only while it says "loaded". */
  fence: () => Promise<FenceState>;
  /** Told each state saved, so each run of a workspace is a session (session-log.ts). */
  sessions: Pick<SessionLog, "sync">;
  now?: () => number;
}

const LOG_TAIL_LINES = 20;
const REAP_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const SAMPLE_INTERVAL_MS = 15_000;
const FLUSH_INTERVAL_MS = 30_000;
/** The Online workspaces stop within this long of the fence going. */
const FENCE_INTERVAL_MS = 5_000;
/** WebSocket close code sent to browsers when their workspace stops ("going away"). */
const CLOSE_GOING_AWAY = 1001;
const CLOSE_INTERNAL_ERROR = 1011;

interface Entry {
  userId: number;
  status: WorkspaceStatus;
  ready: boolean;
  containerId: string | null;
  /** A container that should be gone but whose removal failed (a failed stop or start). Reconcile retries the removal and never adopts it. */
  leftoverContainerId: string | null;
  /** With `kind`, which of the user's workspaces the current container is, or the last one was (workspaceOf); null if it never ran one. */
  agent: AgentKind | null;
  /** "private" if it never ran one. */
  kind: WorkspaceKind;
  version: string | null;
  ip: string | null;
  port: number | null;
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
  agentState: AgentState;
  /** Average CPU use over the last sampling interval. */
  cpuCores: number | null;
  cpuSample: { cpuSeconds: number; at: number } | null;
  /** The last busy reason seen by the stats refresh, to log when work starts. */
  busyReason: BusyReason;
  /** Nobody uses it, but the agent is still working: the reaper stops it once the work is done. */
  stopPending: boolean;
  /** In-flight start, until the container runs (readiness continues in the background). */
  starting: Promise<WorkspaceInfo> | null;
  stopping: Promise<WorkspaceInfo> | null;
  /** In-flight deletion of the user's data; starts are refused meanwhile. */
  deleting: Promise<void> | null;
  /** In-flight erasure of one workspace's files; its starts are refused meanwhile. */
  erasing: { ref: WorkspaceRef; done: Promise<void> } | null;
  readiness: AbortController | null;
  activityDirty: boolean;
}

/** Holds a container and counts against the cap. */
function isActive(entry: Entry): boolean {
  return entry.status === "starting" || entry.status === "running";
}

/** Whether the entry's container is, or its last one was, this workspace's. */
function isWorkspace(entry: Entry, ref: WorkspaceRef): boolean {
  const own = workspaceOf(entry);
  return own !== null && sameWorkspace(own, ref);
}

/** Type-checked in-place update of an entry. */
function patch(entry: Entry, changes: Partial<Entry>): void {
  Object.assign(entry, changes);
}

/** Nothing known about the agent yet. */
const NO_AGENT: AgentState = Object.freeze({ working: null, answeredAt: null, unknown: false });

/** What an entry no longer has once its container is gone. */
const NO_CONTAINER = {
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
} satisfies Partial<Entry>;

/** A user's entry before the first start of any workspace. */
function newEntry(userId: number): Entry {
  return {
    ...NO_CONTAINER,
    userId,
    status: "stopped",
    leftoverContainerId: null,
    agent: null,
    kind: "private",
    startedAt: null,
    stoppedAt: null,
    lastActivityAt: null,
    lastUserActivityAt: null,
    stopReason: null,
    lastError: null,
    starting: null,
    stopping: null,
    deleting: null,
    erasing: null,
    activityDirty: false,
  };
}

/** `flight`, kept where `set` puts it until it settles. That also marks it as handled: a caller that doesn't wait reads the failure from the workspace. */
function inFlight<T>(flight: Promise<T>, set: (flight: Promise<T> | null) => void): Promise<T> {
  set(flight);
  const clear = (): void => set(null);
  flight.then(clear, clear);
  return flight;
}

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
  readonly #fenceCheck: () => Promise<FenceState>;
  /** The last fence check's answer; "unknown" until there is one (Online runs only on "loaded"). */
  #fence: FenceState = "unknown";
  readonly #sessions: Pick<SessionLog, "sync">;
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
    this.#fenceCheck = options.fence;
    this.#sessions = options.sessions;
    this.#now = options.now ?? Date.now;
  }

  /** Loads the persisted state and reconciles it with the containers Docker is running. */
  async init(): Promise<void> {
    // Before reconcile: it adopts an Online container only while the fence is loaded.
    await this.#updateFence();
    const now = this.#now();
    const stale: Entry[] = [];
    for (const row of this.#db.select().from(workspaces).all()) {
      const { userId, status, agent, kind, ip, startedAt, stoppedAt, lastActivityAt, stopReason, lastError } = row;
      const entry: Entry = { ...newEntry(userId), status, agent, kind, ip, startedAt, stoppedAt, lastActivityAt, lastUserActivityAt: lastActivityAt, stopReason, lastError };
      if (status === "stopped" || status === "error") {
        // A stopped workspace's row only names a container whose removal failed (see #persist).
        entry.leftoverContainerId = row.containerId;
      } else {
        // Reconcile adopts the container if it still runs; otherwise this is how it stays. A stop
        // that was under way is finished instead: that container is removed, not adopted.
        const wasStopping = status === "stopping";
        patch(entry, {
          ip: null,
          status: "stopped",
          stoppedAt: now,
          stopReason: wasStopping ? stopReason : "error",
          lastError: wasStopping ? lastError : "The workspace container was not running when the gateway started.",
          leftoverContainerId: wasStopping ? row.containerId : null,
        });
        stale.push(entry);
      }
      this.#entries.set(userId, entry);
    }
    await this.reconcile();
    for (const entry of stale) if (entry.status === "stopped") this.#persist(entry);
  }

  startBackgroundTasks(): void {
    const every = (intervalMs: number, name: string, task: () => unknown): void => {
      // A tick during a run joins it: no task runs alongside itself, and a run that fails is logged once.
      const run = singleFlight(() => Promise.resolve().then(task).catch((error: unknown) => this.#log.error(`${name} failed`, { error })));
      this.#timers.push(setInterval(run, intervalMs).unref());
    };
    every(REAP_INTERVAL_MS, "reaper", () => this.reap());
    every(REAP_INTERVAL_MS, "session sweep", () => {
      const closed = closeEndedSessions(this.#db, this.#connections, this.#now());
      if (closed > 0) this.#log.info("closed the agent connections of ended sessions", { closed });
    });
    every(RECONCILE_INTERVAL_MS, "reconcile", () => this.reconcile());
    every(SAMPLE_INTERVAL_MS, "stats refresh", () => this.refreshSamples());
    every(FLUSH_INTERVAL_MS, "activity flush", () => this.#flushActivity());
    every(FENCE_INTERVAL_MS, "firewall check", () => this.checkFence());
  }

  /** Stops the background tasks and saves pending activity. Containers keep running. */
  shutdown(): void {
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    this.#flushActivity();
  }

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
        return this.#stopEntry(entry, "online_disabled");
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

  /** `onlineAllowed`: the admin's permission for this user, when the caller has read it already. */
  info(userId: number, onlineAllowed?: boolean): WorkspaceInfo {
    const entry = this.#entries.get(userId) ?? newEntry(userId);
    const active = isActive(entry);
    const activity = active ? this.#assess(entry) : null;
    return {
      userId,
      status: entry.status,
      agent: entry.agent,
      kind: entry.kind,
      online: this.#onlineAccess(userId, onlineAllowed),
      agentVersion: active ? entry.version : null,
      ready: entry.ready,
      startedAt: entry.startedAt,
      lastActivityAt: entry.lastActivityAt,
      idleSeconds: activity ? Math.floor(idleMs(activity, this.#now()) / 1000) : null,
      memoryBytes: active ? entry.memoryBytes : null,
      connections: this.#connections.count(userId),
      llmInFlight: this.#llm.inFlightFor(userId),
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
    return [...this.#entries.keys()].sort((a, b) => a - b).map((userId) => this.info(userId, allowed.get(userId) ?? false));
  }

  /** WorkspaceInfo.online: the global switch and the host firewall's fence first, then the admin's permission for this user. */
  #onlineAccess(userId: number, allowed?: boolean): OnlineAccess {
    if (!this.#config.workspace.onlineEnabled || this.#fence !== "loaded") return "off";
    allowed ??= this.#db.select({ onlineAllowed: users.onlineAllowed }).from(users).where(eq(users.id, userId)).get()?.onlineAllowed ?? false;
    return allowed ? "allowed" : "not_allowed";
  }

  /** Why an Online workspace of this user may not run (now), or null when it may. */
  #onlineRefusal(userId: number): HttpError | null {
    if (!this.#config.workspace.onlineEnabled) return onlineDisabled();
    if (this.#fence !== "loaded") return onlineDisabled(true);
    return this.#onlineAccess(userId) === "not_allowed" ? new HttpError(403, "online_not_allowed", "Your administrator hasn't allowed you an Online workspace.") : null;
  }

  /** Workspaces holding a container slot (starting or running). */
  runningCount(): number {
    return [...this.#entries.values()].filter(isActive).length;
  }

  /**
   * The proxy target of this workspace when it is ready, or null while it is not, or while another of the user's
   * workspaces is what runs: a workspace's port only ever reaches that workspace's container.
   */
  upstream(userId: number, ref: WorkspaceRef): Upstream | null {
    const entry = this.#entries.get(userId);
    const endpoint = entry && isWorkspace(entry, ref) && entry.status === "running" && entry.ready ? endpointOf(entry) : null;
    return endpoint && { ...endpoint, ...ref };
  }

  /**
   * The workspace whose container has this address on this kind's network (service API caller identity). Only that
   * kind's containers count: each kind's service listener is on its own network and knows nobody from the other.
   */
  workspaceForIp(kind: WorkspaceKind, ip: string): { userId: number; ref: WorkspaceRef } | null {
    for (const entry of this.#entries.values()) {
      const ref = workspaceOf(entry);
      if (ref !== null && isActive(entry) && ref.kind === kind && entry.ip === ip) return { userId: entry.userId, ref };
    }
    return null;
  }

  /** A person did something in the workspace. Ignored unless the workspace holds a container. */
  touch(userId: number): void {
    const entry = this.#entries.get(userId);
    if (!entry || !isActive(entry)) return;
    entry.lastActivityAt = entry.lastUserActivityAt = this.#now();
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

  #flushActivity(): void {
    const dirty = [...this.#entries.values()].filter((entry) => entry.activityDirty);
    if (dirty.length === 0) return;
    const now = this.#now();
    try {
      this.#db.transaction((tx) => {
        for (const entry of dirty) tx.update(workspaces).set({ lastActivityAt: entry.lastActivityAt, updatedAt: now }).where(eq(workspaces.userId, entry.userId)).run();
      });
      for (const entry of dirty) entry.activityDirty = false;
    } catch (error) {
      this.#log.error("could not save workspace activity", { error });
    }
  }

  /**
   * Starts one of the user's workspaces unless one is already starting or running.
   *   * Which: the one of `agent` and `kind`. Without a kind, Private; without an agent, the one chosen for the user
   *     (users.agent, on Home) when it is enabled, else the first enabled one. Online needs ONLINE_WORKSPACES and the
   *     admin's permission.
   *   * One at a time: while one of the user's workspaces is starting or running, what a start leaves out is that
   *     one's, so it attaches; one that names another agent or kind is refused (`another_running`).
   * Refused too while the user's data (or that workspace's files) is being deleted. See StartAttempt for when
   * capacity is decided.
   */
  requestStart(userId: number, options: StartOptions = {}): StartAttempt {
    const refuse = (status: number, code: string, message: string): StartAttempt => ({ ok: false, error: new HttpError(status, code, message) });
    if (!hasWorkspacePorts(this.#config.agentPortCount, userId)) {
      return refuse(409, "no_workspace_port", `User ${userId} has no workspace port: this portal serves workspaces for user ids 1 to ${this.#config.agentPortCount - 1} (AGENT_PORT_COUNT).`);
    }
    const existing = this.#entries.get(userId);
    if (existing?.deleting) return { ok: false, error: beingDeleted() };
    if (existing?.stopping) return { ok: true, done: existing.stopping.then(() => this.start(userId, options)) };
    const current = existing && (existing.starting || isActive(existing)) ? workspaceOf(existing) : null;
    if (existing && current) {
      if (!sameWorkspace({ agent: options.agent ?? current.agent, kind: options.kind ?? current.kind }, current)) {
        const asked = this.#workspaceFor(userId, options);
        return refuse(409, "another_running", `Your ${workspaceName(current)} workspace is running. Stop it to start the ${workspaceName(asked)} one.`);
      }
      // Someone is using it again: a stop that waited for the agent to finish is off.
      existing.stopPending = false;
      return { ok: true, done: existing.starting ?? Promise.resolve(this.info(userId)) };
    }

    const ref = this.#workspaceFor(userId, options);
    if (ref.kind === "online") {
      const refusal = this.#onlineRefusal(userId);
      if (refusal) return { ok: false, error: refusal };
    }
    if (existing?.erasing && sameWorkspace(existing.erasing.ref, ref)) return { ok: false, error: beingDeleted(ref) };
    if (!this.#config.workspace.agents.includes(ref.agent)) return { ok: false, error: agentUnavailable(ref.agent) };

    const eviction = this.#makeRoom(userId);
    if (eviction === false) return refuse(409, "capacity", `All ${this.#config.maxRunning} workspace slots are in use and none has been idle long enough to make room.`);

    const entry = existing ?? this.#createEntry(userId);
    const now = this.#now();
    this.#persist(entry, {
      ...NO_CONTAINER,
      status: "starting",
      ...ref,
      startedAt: now,
      lastActivityAt: now,
      lastUserActivityAt: now,
      stopReason: null,
      lastError: null,
    });
    return { ok: true, done: inFlight(this.#launch(entry, ref, eviction), (flight) => (entry.starting = flight)) };
  }

  /** The workspace a start means while none of the user's runs: Private without a kind, the preferred agent's without an agent. */
  #workspaceFor(userId: number, { agent, kind }: StartOptions): WorkspaceRef {
    return { agent: agent ?? this.#preferredAgent(userId), kind: kind ?? "private" };
  }

  /** The agent a start without one uses: the user's choice (on Home) if enabled, else the first enabled agent. */
  #preferredAgent(userId: number): AgentKind {
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

  /** A slot for one more workspace: null when one is free, the stop of the workspace that makes room, or false when none can go. */
  #makeRoom(requesterId: number): Promise<WorkspaceInfo> | null | false {
    const active = [...this.#entries.values()].filter(isActive);
    if (active.length < this.#config.maxRunning) return null;
    const candidates = active.map((entry) => ({ ...this.#assess(entry), userId: entry.userId, ready: entry.status === "running" && entry.ready && entry.stopping === null }));
    const victim = chooseEviction(candidates, requesterId, this.#now());
    return victim !== null && this.stop(victim, "capacity");
  }

  async #launch(entry: Entry, ref: WorkspaceRef, eviction: Promise<WorkspaceInfo> | null): Promise<WorkspaceInfo> {
    const { userId } = entry;
    const { agent, kind } = ref;
    try {
      if (eviction) {
        // Wait for the evicted container to go before starting another (memory headroom).
        await eviction.catch(() => undefined);
        // A stop that arrived meanwhile: nothing to start.
        if (entry.status !== "starting") return this.info(userId);
      }
      // A container a failed stop left behind (whichever workspace's) goes first.
      await this.#removeLeftover(entry);
      if (entry.status !== "starting") return this.info(userId);
      prepareWorkspaceFiles(this.#config, userId, ref);
      const credential = driverFor(agent).generateCredential();
      const { version, image } = this.#versions.selection(agent);
      // The fence once more, as late as it gets: an Online container runs only inside it.
      if (kind === "online" && (await this.#updateFence()) !== "loaded") throw onlineDisabled(true);
      if (entry.status !== "starting") return this.info(userId);
      const container = await this.#runtime.startWorkspace(userId, { ref, credential, image });
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
        this.#persist(entry, { ...NO_CONTAINER, status: "stopped", stoppedAt: this.#now(), stopReason: error.code, lastError: null });
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
      this.#persist(other, { ip: null });
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
          this.#persist(entry, { status: "running", ready: true, readiness: null, agentState: { ...NO_AGENT, answeredAt: this.#now() } });
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
    this.#persist(entry, { ...NO_CONTAINER, status: "error", stoppedAt: this.#now(), stopReason: "error", lastError: message });
    this.#audit("workspace_error", userId, { error: firstLine(message), ...workspaceOf(entry) });
    this.#log.error("workspace failed to start", { userId, ...workspaceOf(entry), error: firstLine(message) });
    this.#connections.closeWorkspace(userId, CLOSE_INTERNAL_ERROR, "workspace failed");
    if (containerId) {
      await this.#runtime.removeContainer(containerId).catch((error: unknown) => {
        this.#log.warn("could not remove failed workspace container", { userId, containerId, error });
        // Unless a new start has begun (it removes the container itself), reconcile retries.
        if (entry.status === "error") this.#persist(entry, { leftoverContainerId: containerId });
      });
    }
  }

  stop(userId: number, reason: string, actorUserId: number | null = null): Promise<WorkspaceInfo> {
    const entry = this.#entries.get(userId);
    return entry ? this.#stopEntry(entry, reason, actorUserId) : Promise.resolve(this.info(userId));
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
   * Stops the user's workspace and deletes everything all of them stored (user deletion). Starts are
   * refused until it is done, a start queued behind the stop included. Rejects with `stop_failed`,
   * deleting nothing, when the container can't be removed.
   */
  deleteData(userId: number): Promise<void> {
    const existing = this.#entries.get(userId);
    if (existing?.deleting) return existing.deleting;
    const entry = existing ?? this.#createEntry(userId);
    return inFlight(this.#deleteEntry(entry, existing === undefined), (flight) => (entry.deleting = flight));
  }

  async #deleteEntry(entry: Entry, created: boolean): Promise<void> {
    const { userId } = entry;
    try {
      // An erase removes the same folders, and both at once fail (ENOTEMPTY). No await without one: a start made in the same tick would get as far as its container.
      if (entry.erasing) await entry.erasing.done.catch(() => undefined);
      await this.#stopEntry(entry, "deleted");
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
   * Empties one workspace's home and workspace folders (Admin's "Erase files"), audited `workspace_files_erased` with
   * its kind and agent. Refused (`workspace_running`) while that workspace is starting, running or stopping, or while
   * Docker still has a container of it (one a failed stop left behind and that can't be removed), and (`deleting`)
   * while the user's data is being deleted; its starts are refused until it is done. The user's other workspaces are
   * untouched, and one of them may run meanwhile.
   */
  async eraseFiles(userId: number, ref: WorkspaceRef, actorUserId: number | null = null): Promise<void> {
    const existing = this.#entries.get(userId);
    if (existing?.deleting) throw beingDeleted();
    if (existing?.erasing) {
      if (sameWorkspace(existing.erasing.ref, ref)) return existing.erasing.done;
      await existing.erasing.done.catch(() => undefined);
    }
    const entry = existing ?? this.#createEntry(userId);
    if (isWorkspace(entry, ref) && (entry.starting || entry.stopping || isActive(entry) || entry.status === "stopping")) {
      throw workspaceRunning(ref);
    }
    const done = (async () => {
      // A container a failed stop left behind may be this workspace's and still mount the folders, whichever
      // workspace the entry shows now (another one's failed start leaves it in place), so it goes first; if it
      // can't, nothing is erased.
      await this.#removeLeftover(entry).catch((error: unknown) => {
        this.#log.warn("could not remove a workspace container left behind by a failed stop; its files are not erased", { userId, ...ref, error });
        throw workspaceRunning(ref);
      });
      // And Docker itself must have no container of that workspace (none of the user's that it can't tell, either).
      const containers = await this.#runtime.list();
      if (containers.some((container) => container.userId === userId && (container.ref === null || sameWorkspace(container.ref, ref)))) {
        throw workspaceRunning(ref);
      }
      await eraseWorkspaceFiles(this.#config.dataDir, userId, ref, workspaceOwner(this.#config, userId, ref));
    })();
    entry.erasing = { ref, done };
    try {
      await done;
    } finally {
      if (entry.erasing?.done === done) entry.erasing = null;
      // An entry made only to hold `erasing` goes again, unless a start or a deletion has used it meanwhile.
      if (existing === undefined && entry.startedAt === null && !entry.starting && !entry.deleting && this.#entries.get(userId) === entry) this.#entries.delete(userId);
    }
    this.#audit("workspace_files_erased", userId, ref, actorUserId);
    this.#log.info("workspace files erased", { userId, ...ref, actorUserId });
  }

  /**
   * `reason` goes to stopReason and the audit log, with the user who asked for the stop (`actorUserId`; null for the
   * gateway's own decisions). `lastError`: the container died by itself, and the stop is audited as workspace_error.
   */
  #stopEntry(entry: Entry, reason: string, actorUserId: number | null = null, lastError: string | null = null): Promise<WorkspaceInfo> {
    if (entry.stopping) return entry.stopping;
    if (!entry.starting && !isActive(entry)) return Promise.resolve(this.info(entry.userId));
    return inFlight(this.#halt(entry, reason, actorUserId, lastError), (flight) => (entry.stopping = flight));
  }

  async #halt(entry: Entry, reason: string, actorUserId: number | null, lastError: string | null): Promise<WorkspaceInfo> {
    const { userId } = entry;
    const pendingStart = entry.starting;
    entry.readiness?.abort();
    this.#persist(entry, { status: "stopping", ready: false, readiness: null, stopReason: reason });
    this.#connections.closeWorkspace(userId, CLOSE_GOING_AWAY, "workspace stopped");
    if (pendingStart) await pendingStart.catch(() => undefined);

    const containerId = entry.containerId;
    try {
      if (containerId) await this.#runtime.stopContainer(containerId);
    } catch (error) {
      const message = `could not stop the workspace container: ${errorMessage(error)}`;
      // The container may still run: reconcile retries the removal, and never adopts it.
      this.#persist(entry, { ...NO_CONTAINER, status: "error", stoppedAt: this.#now(), lastError: message, leftoverContainerId: containerId });
      this.#audit("workspace_error", userId, { reason, error: message, ...workspaceOf(entry) }, actorUserId);
      this.#log.error("workspace stop failed", { userId, containerId, error });
      return this.info(userId);
    }

    this.#persist(entry, { ...NO_CONTAINER, status: "stopped", stoppedAt: this.#now(), stopReason: reason, lastError });
    if (lastError) this.#audit("workspace_error", userId, { reason, error: firstLine(lastError), ...workspaceOf(entry) });
    else if (containerId) this.#audit("workspace_stopped", userId, { reason, ...workspaceOf(entry) }, actorUserId);
    this.#log.info("workspace stopped", { userId, ...workspaceOf(entry), reason });
    return this.info(userId);
  }

  /** Removes a container a failed stop or start left behind; rejects if it still can't. */
  async #removeLeftover(entry: Entry): Promise<void> {
    const containerId = entry.leftoverContainerId;
    if (!containerId) return;
    await this.#runtime.stopContainer(containerId);
    if (entry.leftoverContainerId === containerId) this.#persist(entry, { leftoverContainerId: null });
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
    await this.#stopEntry(entry, "error", null, withLogs(describeExit(state), tail));
  }

  /** Stops workspaces nobody uses any more, or that have been idle for IDLE_TIMEOUT_MINUTES. */
  async reap(): Promise<void> {
    const running = [...this.#entries.values()].filter((entry) => entry.status === "running" && entry.ready && !entry.starting && !entry.stopping);
    await Promise.all(running.map((entry) => this.#reapOne(entry)));
  }

  async #reapOne(entry: Entry): Promise<void> {
    // The admin's switch (or ONLINE_WORKSPACES) went off: an Online workspace stops, working or not.
    if (entry.kind === "online") {
      const refusal = this.#onlineRefusal(entry.userId);
      if (refusal) return void (await this.#stopEntry(entry, refusal.code));
    }
    if (this.#verdict(entry) === "keep") return;
    // About to stop it: ask the agent once more, in case work started since the last check.
    const containerId = entry.containerId;
    await this.#refreshAgentState(entry);
    if (entry.status !== "running" || entry.containerId !== containerId || entry.stopping || entry.starting) return;
    const verdict = this.#verdict(entry);
    if (verdict !== "keep") await this.#stopEntry(entry, verdict === "released" ? "logout" : "idle");
  }

  /** The reaper's verdict now; a workspace nobody uses whose agent still works is marked to stop once the work is done. */
  #verdict(entry: Entry): ReapVerdict {
    const { busy, lastActivityAt } = this.#assess(entry);
    const sessions = this.#sessionsUsing(entry.userId);
    entry.stopPending = sessions === 0 && busy;
    return reapVerdict({ busy, lastActivityAt, now: this.#now(), idleTimeoutMs: this.#config.idleTimeoutMs, sessions });
  }

  /**
   * Every 15 s: memory and CPU from docker stats, whether the agent is working from its status check, and
   * containers that exited. Work counts as activity, so the idle countdown only starts once the agent is done.
   */
  async refreshSamples(): Promise<void> {
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
          entry.ready && this.#refreshAgentState(entry, false),
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
  }

  /**
   * Asks the workspace's agent whether it is working. Without an answer the last one is kept and the
   * state becomes unknown (see agentCountsAsWorking).
   */
  async #refreshAgentState(entry: Entry, updateBusy = true): Promise<void> {
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
    if (updateBusy) this.#updateBusy(entry);
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
  readonly reconcile = singleFlight(async (): Promise<void> => {
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
      const refusal = entry && container.ref?.kind === "online" ? this.#onlineRefusal(entry.userId) : null;
      if (entry && container.ref && container.running && !isActive(entry) && refusal) {
        await this.#stopRefused(entry, container.id, container.ref, refusal);
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
  });

  /**
   * An Online container found running that may not run (ONLINE_WORKSPACES is off, or the admin barred the user since):
   * stopped, not adopted, and recorded as stopped for that reason.
   */
  async #stopRefused(entry: Entry, containerId: string, ref: WorkspaceRef, refusal: HttpError): Promise<void> {
    const reason = refusal.code;
    this.#log.info("stopping an Online workspace that may not run", { userId: entry.userId, containerId, reason });
    try {
      await this.#runtime.stopContainer(containerId);
    } catch (error) {
      this.#log.warn("could not stop an Online workspace that may not run; reconcile retries", { userId: entry.userId, containerId, error });
      return;
    }
    this.#persist(entry, { ...NO_CONTAINER, ...ref, status: "stopped", stoppedAt: this.#now(), stopReason: reason, lastError: null });
    this.#audit("workspace_stopped", entry.userId, { reason, ...ref });
  }

  /** Tracks a container that was already running (gateway restart); readiness is checked again. */
  async #adopt(entry: Entry, container: ContainerSummary): Promise<boolean> {
    const { ref } = container;
    if (!container.ip || ref === null || container.port === null) return false;
    if (!hasWorkspacePorts(this.#config.agentPortCount, entry.userId)) {
      // AGENT_PORT_COUNT went down since it started: no port reaches it.
      this.#log.warn("not adopting a workspace container of a user without a workspace port (AGENT_PORT_COUNT)", { userId: entry.userId, containerId: container.id });
      return false;
    }
    const credential = await this.#runtime.credential(container.id, ref.agent).catch(() => null);
    if (!credential) {
      this.#log.warn("cannot adopt workspace container: its credential is unknown", { userId: entry.userId, containerId: container.id });
      if (!entry.starting && !entry.stopping && !isActive(entry)) {
        this.#persist(entry, { lastError: "After a gateway restart the running workspace could not be taken over (its access token was missing), so it was removed. Start it again." });
      }
      return false;
    }
    if (entry.starting || entry.stopping || entry.deleting || isActive(entry)) return false;
    const now = this.#now();
    patch(entry, {
      ...NO_CONTAINER,
      status: "starting",
      ...ref,
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
    this.#log.info("adopted running workspace container", { userId: entry.userId, ...ref, containerId: container.id });
    this.#watchReadiness(entry);
    return true;
  }

  /** Busy, why, and where the idle countdown runs from (policy.ts decides). */
  #assess(entry: Entry): ActivityAssessment {
    return assessActivity({ ...entry, agent: entry.agentState, llmBusy: this.#llm.pendingFor(entry.userId) > 0 }, this.#now(), this.#config.maxBusyMs);
  }

  #sessionsUsing(userId: number): number {
    return countSessionsUsingWorkspace(this.#db, userId, this.#now());
  }

  #createEntry(userId: number): Entry {
    const entry = newEntry(userId);
    this.#entries.set(userId, entry);
    return entry;
  }

  /** Saves the entry, with `changes` applied first. */
  #persist(entry: Entry, changes: Partial<Entry> = {}): void {
    patch(entry, changes);
    const { userId, ip, status, agent, kind, startedAt, stoppedAt, lastActivityAt, stopReason, lastError } = entry;
    // A stopped workspace keeps the id of a container whose removal failed, so a restarted gateway
    // removes it too instead of adopting it.
    const containerId = entry.containerId ?? entry.leftoverContainerId;
    const ref = workspaceOf(entry);
    const container = { containerId, containerName: containerId && ref ? containerName(userId, ref) : null };
    const row = { ...container, ip, status, agent, kind, startedAt, stoppedAt, lastActivityAt, stopReason, lastError, updatedAt: this.#now() };
    try {
      this.#db.insert(workspaces).values({ userId, ...row }).onConflictDoUpdate({ target: workspaces.userId, set: row }).run();
      entry.activityDirty = false;
    } catch (error) {
      this.#log.error("could not save workspace state", { userId: entry.userId, error });
    }
    this.#sessions.sync(entry);
  }

  #audit(action: AuditAction, userId: number, details?: unknown, actorUserId: number | null = null): void {
    try {
      writeAudit(this.#db, { action, actorUserId, targetUserId: userId, details });
    } catch (error) {
      this.#log.error("could not write audit entry", { action, userId, error });
    }
  }
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
