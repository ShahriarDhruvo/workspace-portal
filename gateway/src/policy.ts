// Pure lifecycle decisions: when a workspace counts as busy or idle, when the reaper stops it, and
// which workspace makes room when the running cap is reached.
//
// The rule the user sees: a workspace is only stopped for inactivity when nobody has used it for
// IDLE_TIMEOUT_MINUTES *and* the agent is not working on anything. Work (a turn in progress, an LLM
// request, sustained CPU) counts as activity, so the idle countdown starts when the work ends.

/** Only workspaces idle for longer than this can be evicted to make room for another user. */
export const EVICTION_MIN_IDLE_MS = 5 * 60_000;
/** Average CPU (in cores) over a sampling window above which a container counts as working. */
export const BUSY_CPU_CORES = 0.15;

/** Why a workspace counts as working right now; null when it is not. */
export type BusyReason = "task" | "llm" | "cpu" | null;

export interface BusySignals {
  /** The agent reports a turn in progress (generating, running a tool, waiting for approval). null: unknown. */
  agentTask: boolean | null;
  /** An LLM request of this workspace is queued or in flight. */
  llmBusy: boolean;
  /** Average CPU use over the last sampling window, in cores; null when not measured yet. */
  cpuCores: number | null;
}

/** The strongest reason a workspace is working, or null. */
export function busyReason(signals: BusySignals): BusyReason {
  if (signals.agentTask === true) return "task";
  if (signals.llmBusy) return "llm";
  if (signals.cpuCores !== null && signals.cpuCores > BUSY_CPU_CORES) return "cpu";
  return null;
}

export interface ActivitySnapshot {
  lastActivityAt: number | null;
  /** The workspace is working (see busyReason). */
  busy: boolean;
}

/** Time since the workspace last did anything; 0 while it works or if it has never been seen. */
export function idleMs(snapshot: ActivitySnapshot, now: number): number {
  if (snapshot.busy || snapshot.lastActivityAt === null) return 0;
  return Math.max(0, now - snapshot.lastActivityAt);
}

/**
 * - keep: in use, working, or not idle long enough.
 * - idle: nobody used it for the idle timeout and it is not working.
 * - released: no session uses it any more (everyone signed out, or sessions expired) and it is
 *   not working. A sign-out while the agent works lands here once the work is done.
 */
export type ReapVerdict = "keep" | "idle" | "released";

export interface ReapInput extends ActivitySnapshot {
  now: number;
  idleTimeoutMs: number;
  /** countSessionsUsingWorkspace() for this workspace. */
  sessions: number;
}

/** The reaper's decision for one running workspace. A working workspace is never stopped. */
export function reapVerdict(input: ReapInput): ReapVerdict {
  if (input.busy) return "keep";
  if (input.sessions === 0) return "released";
  return idleMs(input, input.now) >= input.idleTimeoutMs ? "idle" : "keep";
}

export interface EvictionCandidate extends ActivitySnapshot {
  userId: number;
  ready: boolean;
}

/**
 * The longest-idle ready workspace idle for more than `minIdleMs`, never the requester's and never
 * one that is working; null if none.
 */
export function chooseEviction(
  candidates: readonly EvictionCandidate[],
  requesterId: number,
  now: number,
  minIdleMs = EVICTION_MIN_IDLE_MS,
): number | null {
  let best: { userId: number; idle: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.userId === requesterId || !candidate.ready || candidate.busy) continue;
    const idle = idleMs(candidate, now);
    if (idle > minIdleMs && (best === null || idle > best.idle)) best = { userId: candidate.userId, idle };
  }
  return best?.userId ?? null;
}

/** Average cores used between two cumulative CPU samples; null when the interval is unusable. */
export function averageCores(
  previous: { cpuSeconds: number; at: number } | null,
  current: { cpuSeconds: number; at: number },
): number | null {
  if (!previous) return null;
  const wallSeconds = (current.at - previous.at) / 1000;
  const used = current.cpuSeconds - previous.cpuSeconds;
  if (wallSeconds <= 0 || used < 0) return null; // clock went backwards or the container restarted
  return used / wallSeconds;
}
