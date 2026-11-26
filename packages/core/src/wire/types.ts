// The gateway's control API as JSON (docs/ARCHITECTURE.md, "Gateway control API"): what the gateway sends, what the
// web app reads and passes on to the browser. Types only. Where the gateway hands on what portal-hostd sent
// (hostd/README.md), those shapes are here too.
import type { EnergyPriceSource } from "./energy-locations.ts";
import type { AgentKind, HostRole, WorkspaceKind, WorkspaceRef, WorkspaceStatus } from "./kinds.ts";

/** The error body of every gateway API and of the portal's own JSON routes: a code and a text for people. */
export interface ApiError {
  error: string;
  message: string;
}

export type OnlineAccess = "allowed" | "off" | "not_allowed";

/** Why a workspace counts as working: "task" (the agent reports work), "llm" (a model request), "cpu" (sustained CPU); null when it is not. */
export type BusyReason = "task" | "llm" | "cpu" | null;

/** GET /control/workspaces → workspaces[], GET /control/workspaces/:id, and the answers of start, stop, attach, release. */
export interface WorkspaceInfo {
  userId: number;
  status: WorkspaceStatus;
  /** The agent of the starting or running container; when stopped, the one used last; null if never started. */
  agent: AgentKind | null;
  /** The kind of the starting or running container; when stopped, the one used last ("private" if never started). */
  kind: WorkspaceKind;
  /**
   * Whether this user may start an Online workspace now: "allowed"; "off" when ONLINE_WORKSPACES=off; "not_allowed"
   * when the admin barred this user (users.online_allowed).
   */
  online: OnlineAccess;
  /** The agent version of the starting or running container's image; null when stopped or unknown. */
  agentVersion: string | null;
  /** The agent answered its readiness probe and can take prompts. */
  ready: boolean;
  startedAt: number | null;
  lastActivityAt: number | null;
  /** null when not running. */
  idleSeconds: number | null;
  /** From docker stats; null when not running or unknown. */
  memoryBytes: number | null;
  /**
   * Sessions that have it open right now: an open connection (event stream, socket) or a request in
   * the last 20 s (presence). Counted per session, by the session's role.
   */
  connections: { owner: number; admin: number };
  llmInFlight: number;
  /** The agent is working: it is never stopped for inactivity while this is true. */
  busy: boolean;
  busyReason: BusyReason;
  /** Nobody uses it any more; it stops by itself once the agent's work is done. */
  stopPending: boolean;
  /** "logout" | "idle" | "admin" | "user" | "deactivated" | "deleted" | "capacity" | "error" | ... */
  stopReason: string | null;
  lastError: string | null;
}

/** A TCP port something in a running workspace listens on (1024-65535, never the harness's own). */
export interface WorkspaceServer {
  port: number;
  /** False when it listens on localhost only: the gateway reaches a workspace by its network address. */
  reachable: boolean;
}

/** GET /control/workspaces/:id/servers. `workspace`: the one that runs and is ready, else null (and no servers). */
export interface WorkspaceServers {
  workspace: WorkspaceRef | null;
  servers: WorkspaceServer[];
}

/** GET /control/stats. The gateway runs with the host's /proc, so these are host figures. */
export interface HostStats {
  running: number;
  maxRunning: number;
  idleTimeoutMinutes: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  cpus: number;
  llm: { inFlight: number; queued: number; maxConcurrency: number };
}

/** GET /control/agents → agents[]: one of the agents enabled on this install, in display order. */
export interface AgentInfo {
  id: AgentKind;
  /** Display name, as in AGENT_NAMES. */
  name: string;
  description: string;
  /** The version new workspaces start with, e.g. "0.27.0". */
  version: string;
}

/** A release's notes on GitHub (the agents' and the LLM engine's). */
export interface ReleaseNotes {
  title: string;
  /** The release's page on github.com. */
  url: string;
  publishedAt: number | null;
  /** Markdown, cut when long (the page links to the full notes). */
  body: string;
  /** The notes announce breaking changes (by the conventions changelogs follow; never guessed). */
  breaking: boolean;
}

/** A workspace image of one agent version that Docker has. */
export interface InstalledImage {
  version: string;
  /** e.g. workspace-portal/workspace:dsh-0.2.2-rc.1 */
  image: string;
  sizeBytes: number;
  /** Epoch ms. */
  createdAt: number;
  /** New workspaces start from it. */
  current: boolean;
  /** Workspace containers (starting or running) using it. */
  inUse: number;
}

/** One version in an agent's Package images table. */
export interface AgentRelease {
  version: string;
  /** Epoch ms the registry published it; null when unknown. */
  publishedAt: number | null;
  /** dist-tags.latest names it. */
  latest: boolean;
  /** Its release on the package's GitHub repository; null when there is none (or GitHub never answered). */
  notes: ReleaseNotes | null;
}

/** GET /control/agents/versions → agents[]: one enabled agent's versions, releases and images. */
export interface AgentVersionInfo {
  id: AgentKind;
  name: string;
  /** "@qwen-code/qwen-code" | "@deepseek-ai/dsh" | "@opencode/cli" */
  packageName: string;
  /** New workspaces start with this version. */
  current: string;
  /** From .env: what a fresh install builds. */
  defaultVersion: string;
  /** dist-tags.latest; null when unknown. */
  latest: string | null;
  /** latest is newer than current (semver precedence, prereleases included). */
  updateAvailable: boolean;
  /** The newest stable releases, the current version and those with an image on this server, newest first. */
  releases: AgentRelease[];
  /** This agent's workspace images in Docker, newest version first. */
  installed: InstalledImage[];
  /** Starting and running workspaces by image version (null: unknown), newest first. */
  running: Array<{ version: string | null; count: number }>;
}

/**
 * An update job, an agent's or the LLM engine's. Each of the two updaters runs one at a time, and its last job stays
 * visible until the next starts or the gateway restarts. A job runs while `finishedAt` is null.
 */
export interface UpdateJob<Phase extends string> {
  id: string;
  /** The version in use when the job started; null when unknown. */
  fromVersion: string | null;
  /** The exact version being installed. */
  toVersion: string;
  /** That version's image was on the server already: it is used as it is, nothing is built or downloaded. */
  reuse: boolean;
  phase: Phase;
  /** What it is doing right now, in words. */
  step: string | null;
  /** The last lines of its output. */
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  /** Why it failed, or that it was cancelled; null while it runs and after it succeeded. */
  error: string | null;
  /** The admin who asked for it. */
  actorUserId: number | null;
}

/**
 * An agent update's phases: building → verifying → succeeded, or failed / cancelled from either (the current
 * version then stays as it was).
 */
export type UpdatePhase = "building" | "verifying" | "succeeded" | "failed" | "cancelled";

/**
 * POST /control/agents/:agent/update, and GET /control/agents/versions → job. With `reuse` nothing is built: only the
 * version check runs. `step` is the build step it is at, e.g. "[dsh 3/6] RUN npm install -g …", null before the first
 * and once finished; `log` the last 200 lines of build output.
 */
export interface AgentUpdateJob extends UpdateJob<UpdatePhase> {
  agent: AgentKind;
  fromVersion: string;
  /** Built without the cache: fresh system packages and npm install. */
  rebuild: boolean;
}

/** GET /control/agents/versions[?refresh=1]. */
export interface AgentVersionsOverview {
  /** The enabled agents, in WORKSPACE_AGENTS order. */
  agents: AgentVersionInfo[];
  job: AgentUpdateJob | null;
  /** The last registry check failed: releases and latest are unknown or stale. */
  registryError: string | null;
  /** Epoch ms of the last successful registry check. */
  checkedAt: number | null;
}

/** Body of POST /control/agents/:agent/update. */
export interface AgentUpdateRequest {
  /** An exact version (0.27.4, 0.2.2-rc.3). */
  version: string;
  /** Build without the cache. */
  rebuild?: boolean;
  /** The admin who asked, for the gateway's audit entries. */
  actorUserId?: number;
}

/** An engine image on the LLM server, as portal-hostd lists it. */
export interface EngineImage {
  id: string;
  digest: string | null;
  version: string | null;
  revision: string | null;
  createdAt: number | null;
  sizeBytes: number | null;
  current: boolean;
  previous: boolean;
}

/** portal-hostd's own job (a download, or a restart with another image), which the gateway's update job follows. */
export interface EngineJob {
  id: string;
  kind: "pull" | "apply";
  image: string | null;
  version: string | null;
  phase: "running" | "succeeded" | "failed" | "cancelled";
  step: string;
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  rolledBack: boolean;
}

/** portal-hostd's GET /v1/engine. */
export interface EngineStatus {
  unit: string;
  quadlet: string;
  repository: string;
  /** The quadlet's Image= value. */
  image: string;
  digest: string | null;
  version: string | null;
  revision: string | null;
  state: string;
  subState: string;
  ready: boolean;
  /** Behind llama-swap: the engine is stopped on purpose, to make room for the image models, and starts on demand. */
  unloaded: boolean;
  buildInfo: string | null;
  previous: { image: string; digest: string | null; version: string | null } | null;
  images: EngineImage[];
  job: EngineJob | null;
}

/** One version in the engine's Package images table. */
export interface EngineRelease {
  version: string;
  /** The image's digest (sha256:...); null when the registry didn't say. */
  digest: string | null;
  /** The registry's `latest` tag points at this version. */
  latest: boolean;
  notes: ReleaseNotes | null;
}

export interface EngineReleaseList {
  repository: string;
  /** The newest releases, and the versions the LLM server runs or has an image of, newest first. */
  releases: EngineRelease[];
  checkedAt: number | null;
  error: string | null;
}

/**
 * An engine update's phases: pulling (skipped with `reuse`) → draining → restarting → succeeded, or failed from any of
 * them, or cancelled while pulling or draining.
 */
export type EngineUpdatePhase = "pulling" | "draining" | "restarting" | "succeeded" | "failed" | "cancelled";

/**
 * POST /control/engine/update, and GET /control/engine → job. `toVersion` is the version asked for and, once it
 * succeeded, the one the engine reports; `log` the last 400 lines, portal-hostd's among them.
 */
export interface EngineUpdateJob extends UpdateJob<EngineUpdatePhase> {
  step: string;
  image: string | null;
  /** hostd put the previous image back after the new one failed. */
  rolledBack: boolean;
  /** While draining: since when, until when at most, and how many requests are still running. */
  drain: { since: number; deadline: number; inFlight: number } | null;
  /** The update can still be cancelled with nothing changed. */
  cancellable: boolean;
}

/** GET /control/engine[?refresh=1]. */
export interface EngineOverview {
  /** off: no portal-hostd for the LLM server; offline: it can't be reached; no_engine: it controls no engine. */
  state: "off" | "offline" | "no_engine" | "ok";
  error: string | null;
  engine: EngineStatus | null;
  releases: EngineReleaseList | null;
  job: EngineUpdateJob | null;
  drainMinutes: number;
}

// The live view: GET /control/live sends `init` once, then a `frame` every frameMs.

/** portal-hostd's `info` event. */
export interface HostInfo {
  hostname: string;
  role: HostRole;
  os: string;
  kernel: string;
  intervalMs: number;
  cpu: { model: string; cores: number; threads: number; maxMhz: number | null };
  gpu: { name: string; maxMhz: number | null } | null;
  memory: { totalBytes: number };
  sources: { perf: boolean; bandwidth: string | null; power: string | null; gpuBusy: string | null };
  power: { label: string } | null;
  engine: { unit: string } | null;
  /** The physical network interfaces that `net` counts (not lo, bridges, veth or VPN tunnels). */
  network: { interfaces: string[] } | null;
  /** The whole disks that `disk` I/O counts, and the mount points of the local filesystems its space adds up. */
  disks: { devices: string[]; mounts: string[] } | null;
}

/** portal-hostd's `sample` event. */
export interface HostSample {
  /** Epoch ms on the host. */
  t: number;
  cpu: { usage: number | null; mhz: number | null; mhzPeak: number | null; tempC: number | null; powerW: number | null; coreUsage: Array<number | null>; coreMhz: Array<number | null> };
  gpu: { usage: number | null; mhz: number | null; tempC: number | null; powerW: number | null; memUsedBytes: number | null; memTotalBytes: number | null } | null;
  memory: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    gpuBytes: number | null;
    swapTotalBytes: number;
    swapUsedBytes: number;
    readBps: number | null;
    writeBps: number | null;
  };
  power: { watts: number | null; parts: { gpu: number | null; cpu: number | null; dram: number | null } };
  fans: Array<{ label: string; rpm: number | null; duty: number | null }>;
  throttling: boolean | null;
  /** Bytes per second over the physical interfaces together. */
  net: { rxBps: number | null; txBps: number | null } | null;
  /** Bytes per second over the whole disks together, and the local filesystems' space together. */
  disk: { readBps: number | null; writeBps: number | null; totalBytes: number | null; freeBytes: number | null } | null;
}

/** A server's totals for the current local day, as host_daily has them. */
export interface HostToday {
  /** YYYY-MM-DD, local (usageDay). */
  day: string;
  /** null while the server's power has never been measurable. */
  energyWh: number | null;
  rxBytes: number;
  txBytes: number;
}

/** off: not set up (no token); connecting; online: readings arrive; offline: hostd can't be reached or refused. */
export type HostState = "off" | "connecting" | "online" | "offline";

/** A server in a frame: its readings, and its totals for today. */
export interface HostLive {
  role: HostRole;
  state: HostState;
  /** Why it is offline. */
  error: string | null;
  info: HostInfo | null;
  sample: HostSample | null;
  /** null until the energy meter has read this server today. */
  today: HostToday | null;
}

/** unloaded: behind llama-swap, the LLM is stopped while the image models run, or is starting again. */
export type EngineState = "ready" | "loading" | "unloaded" | "offline" | "unknown";
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

export interface LiveFrame {
  /** Gateway time (epoch ms), for "since" values. */
  t: number;
  hosts: Record<HostRole, HostLive>;
  llm: LlmLive;
  /** Changes whenever the workspace sessions do: the sessions table reads its page again. */
  sessionsVersion: number;
}

/** A frame's LLM totals, kept for the chart. */
export interface LlmTotalsPoint {
  t: number;
  readTps: number;
  writeTps: number;
}

export interface LiveInit {
  frameMs: number;
  /** The last minute of readings per server, oldest first. */
  history: Record<HostRole, HostSample[]>;
  /** The LLM totals of the recent frames, oldest first. */
  llmHistory: LlmTotalsPoint[];
}

/** A price source's last download: `at` the last try, `okAt` the last that stored prices. */
export interface EnergyPriceSourceStatus {
  at: number | null;
  okAt: number | null;
  /** Rows the last good download stored. */
  rows: number;
  /** Why the last try failed; null after a good one. */
  error: string | null;
}

/** GET /control/energy-prices and POST /control/energy-prices/refresh. */
export type EnergyPriceStatus = Record<EnergyPriceSource, EnergyPriceSourceStatus>;
