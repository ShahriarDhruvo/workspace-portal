// Gateway control API types (docs/ARCHITECTURE.md) plus the shapes of the portal's own JSON routes.
// Type-only module: safe to import from client components.
import type { AgentKind, WorkspaceStatus } from "@portal/db";

/** GET /control/agents: one of the agents enabled on this install (the chooser's cards, in display order). */
export interface AgentInfo {
  id: AgentKind;
  /** Display name, as in AGENT_NAMES. */
  name: string;
  description: string;
  /** The version in the workspace image, e.g. "0.27.0". */
  version: string;
}

/** Body of POST /control/workspaces/:id/start and of POST /api/workspace/start. */
export interface StartRequest {
  /**
   * Omitted: attach to whatever is starting or running; otherwise start the only agent enabled, or with several
   * the workspace's last one (400 `agent_required` if it never ran one).
   */
  agent?: AgentKind;
}

export interface WorkspaceInfo {
  userId: number;
  status: WorkspaceStatus;
  /**
   * The agent of the starting or running container; when stopped (or error), the one used last; null if the
   * workspace never started.
   */
  agent: AgentKind | null;
  /** The agent answered its health check. */
  ready: boolean;
  startedAt: number | null;
  lastActivityAt: number | null;
  /** null when not running. */
  idleSeconds: number | null;
  /** From docker stats; null when not running or unknown. */
  memoryBytes: number | null;
  /**
   * Sessions that have the workspace open: an event stream or WebSocket right now, or a request within the
   * last 20 s (an open Web Shell tab polls). Counted per session, by the session's role.
   */
  connections: { owner: number; admin: number };
  llmInFlight: number;
  /** The agent is working: a turn in progress, an LLM request, or sustained CPU. Never idle-stopped. */
  busy: boolean;
  busyReason: "task" | "llm" | "cpu" | null;
  /** Nobody uses it any more but it is still working; it stops once the work is done. */
  stopPending: boolean;
  /** "logout" | "idle" | "admin" | "user" | "deactivated" | "deleted" | "capacity" | "error" | ... */
  stopReason: string | null;
  lastError: string | null;
}

export interface HostStats {
  running: number;
  maxRunning: number;
  idleTimeoutMinutes: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  loadAvg: [number, number, number];
  cpus: number;
  llm: { inFlight: number; queued: number; maxConcurrency: number };
}

/** Error body used by the gateway and by the portal's JSON routes. */
export interface ApiError {
  error: string;
  message: string;
}

/** GET /api/workspace/status, POST /api/workspace/start and POST /api/workspace/stop. */
export interface WorkspaceStatusResponse extends WorkspaceInfo {
  /** Whose workspace this session uses (the gateway routes the iframe there). */
  targetUserId: number;
  /** True when an admin is viewing someone else's workspace. */
  actingAs: boolean;
  /** The agents enabled on this install, in display order: what the page offers when nothing runs. */
  agents: AgentInfo[];
}

/** GET /api/admin/overview. Either part is null when the gateway could not provide it. */
export interface AdminOverview {
  workspaces: WorkspaceInfo[] | null;
  stats: HostStats | null;
  error: ApiError | null;
}
