// The admin's live view: the events of GET /api/admin/live, passed through from the gateway's GET /control/live
// (docs/ARCHITECTURE.md, "Live view"). HostInfo and HostSample are portal-hostd's (hostd/README.md).

export type HostRole = "portal" | "llm";
/** off: not set up; connecting; online: readings arrive; offline: portal-hostd can't be reached or refused. */
export type HostState = "off" | "connecting" | "online" | "offline";

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
  /** The physical network interfaces counted in `net` (not lo, bridges, veth or VPN tunnels); absent from older hostd. */
  network?: { interfaces: string[] } | null;
  /** The whole disks counted in `disk` I/O, and the mount points of the local filesystems counted in its space. */
  disks?: { devices: string[]; mounts: string[] } | null;
}

export interface HostSample {
  t: number;
  cpu: { usage: number | null; mhz: number | null; mhzPeak: number | null; tempC: number | null; powerW: number | null; coreUsage: number[]; coreMhz: Array<number | null> };
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
  throttling?: boolean | null;
  /** Physical interfaces together, bytes per second; absent from older hostd. */
  net?: { rxBps: number | null; txBps: number | null } | null;
  /** Whole disks together (bytes per second), and space on the local filesystems together; absent from older hostd. */
  disk?: { readBps: number | null; writeBps: number | null; totalBytes: number | null; freeBytes: number | null } | null;
}

/** A server's totals for the current local day, from the gateway's energy meter (stored in host_daily). */
export interface HostToday {
  /** YYYY-MM-DD, local. */
  day: string;
  /** null: its power can't be measured. */
  energyWh: number | null;
  rxBytes: number;
  txBytes: number;
}

export interface HostLive {
  role: HostRole;
  state: HostState;
  error: string | null;
  info: HostInfo | null;
  sample: HostSample | null;
  /** Today's totals so far; null until the energy meter has read this server once. */
  today: HostToday | null;
}

export type EngineState = "ready" | "loading" | "offline" | "unknown";

export interface LlmSession {
  slot: number | null;
  userId: number | null;
  userName: string | null;
  phase: "preparing" | "reading" | "writing";
  promptTokens: number | null;
  cachedTokens: number | null;
  processedTokens: number | null;
  generatedTokens: number;
  readTps: number | null;
  writeTps: number | null;
  startedAt: number;
}

export interface LlmWaiting {
  userId: number;
  userName: string | null;
  since: number;
  stage: "portal" | "engine";
}

export interface LlmFinished {
  userId: number;
  userName: string | null;
  finishedAt: number;
  durationMs: number;
  ttftMs: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  generatedTokens: number | null;
  readTps: number | null;
  writeTps: number | null;
  ok: boolean;
}

export interface LlmLive {
  engine: EngineState;
  sessionsReported: boolean;
  engineSessions: number | null;
  maxConcurrency: number;
  inFlight: number;
  queued: number;
  paused: boolean;
  sessions: LlmSession[];
  waiting: LlmWaiting[];
  totals: { readTps: number; writeTps: number };
  recent: LlmFinished[];
}

export interface LiveFrame {
  t: number;
  hosts: Record<HostRole, HostLive>;
  llm: LlmLive;
}

export interface LlmTotalsPoint {
  t: number;
  readTps: number;
  writeTps: number;
}

export interface LiveInit {
  frameMs: number;
  history: Record<HostRole, HostSample[]>;
  llmHistory: LlmTotalsPoint[];
}
