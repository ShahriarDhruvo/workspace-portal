// Pure lifecycle decisions: when a workspace counts as busy or idle, when the reaper stops it, and
// which workspace makes room when the running cap is reached.
//
// The rule the user sees: a workspace is only stopped for inactivity when nobody has used it for
// IDLE_TIMEOUT_MINUTES *and* the agent is not working on anything. Work (a turn in progress, an LLM
// request, sustained CPU) counts as activity, so the idle countdown starts when the work ends.
// Safety net: MAX_BUSY_HOURS after a person last did anything, work no longer counts and only that
// person's last action starts the idle countdown.
import type { BusyReason } from "@portal/core";

/** Only workspaces idle for longer than this can be evicted to make room for another user. */
export const EVICTION_MIN_IDLE_MS = 5 * 60_000;
/** Average CPU (in cores) over a sampling window above which a container counts as working. */
export const BUSY_CPU_CORES = 0.15;
/**
 * When the agent's status check does not answer, its state is unknown. It counts as working for this long after
 * the last answer (a busy agent can be slow to answer), and as not working after that, so a broken one can't keep
 * its workspace up forever.
 */
export const AGENT_UNKNOWN_GRACE_MS = 5 * 60_000;

/** What the gateway knows about the agent from its status check. */
export interface AgentState {
  /** The last answer said the agent was working; null before the first answer. */
  working: boolean | null;
  /** When the last answer came; null before the first. */
  answeredAt: number | null;
  /** The latest check got no answer (error or timeout). `working` is then the last known state. */
  unknown: boolean;
}

/** Whether the agent counts as working: what it last said, or while unknown, see AGENT_UNKNOWN_GRACE_MS. */
export function agentCountsAsWorking(agent: AgentState, now: number): boolean {
  if (!agent.unknown) return agent.working === true;
  return agent.answeredAt !== null && now - agent.answeredAt < AGENT_UNKNOWN_GRACE_MS;
}

interface BusySignals {
  /** The agent reports work in progress (AgentStatus.working: generating, running a tool, a background task). null: unknown. */
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

interface ActivitySnapshot {
  /** Where the idle countdown runs from. */
  lastActivityAt: number | null;
  /** The workspace is working (see busyReason). */
  busy: boolean;
}

/** Everything the gateway tracks about one running workspace's activity. */
export interface WorkspaceActivity extends Omit<BusySignals, "agentTask"> {
  agent: AgentState;
  /** Last activity of any kind: a person using it, or the agent working. */
  lastActivityAt: number | null;
  /** Last thing a person did in it. */
  lastUserActivityAt: number | null;
}

export interface ActivityAssessment extends ActivitySnapshot {
  busyReason: BusyReason;
}

/** A person last did something longer ago than `maxBusyMs` (0: no limit). */
export function pastBusyLimit(lastUserActivityAt: number | null, now: number, maxBusyMs: number): boolean {
  return maxBusyMs > 0 && lastUserActivityAt !== null && now - lastUserActivityAt > maxBusyMs;
}

/**
 * Busy or not, and where the idle countdown runs from. Past the busy limit (MAX_BUSY_HOURS) a stuck
 * or looping agent's work no longer counts, and neither do its own steps or LLM and search calls:
 * the countdown runs from the person's last action.
 */
export function assessActivity(activity: WorkspaceActivity, now: number, maxBusyMs: number): ActivityAssessment {
  if (pastBusyLimit(activity.lastUserActivityAt, now, maxBusyMs)) return { busyReason: null, busy: false, lastActivityAt: activity.lastUserActivityAt };
  const reason = busyReason({ ...activity, agentTask: agentCountsAsWorking(activity.agent, now) });
  return { busyReason: reason, busy: reason !== null, lastActivityAt: activity.lastActivityAt };
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

interface ReapInput extends ActivitySnapshot {
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

/** The longest-idle ready workspace idle for more than EVICTION_MIN_IDLE_MS (so never one that is working), never the requester's; null if none. */
export function chooseEviction(candidates: readonly EvictionCandidate[], requesterId: number, now: number): number | null {
  const idle = (candidate: EvictionCandidate): number => idleMs(candidate, now);
  const evictable = candidates.filter((candidate) => candidate.userId !== requesterId && candidate.ready && idle(candidate) > EVICTION_MIN_IDLE_MS);
  return evictable.sort((a, b) => idle(b) - idle(a))[0]?.userId ?? null;
}

/** Average cores used between two cumulative CPU samples; null when the interval is unusable. */
export function averageCores(previous: { cpuSeconds: number; at: number } | null, current: { cpuSeconds: number; at: number }): number | null {
  if (!previous) return null;
  const wallSeconds = (current.at - previous.at) / 1000;
  const used = current.cpuSeconds - previous.cpuSeconds;
  if (wallSeconds <= 0 || used < 0) return null; // clock went backwards or the container restarted
  return used / wallSeconds;
}
