// Gateway control API types (docs/ARCHITECTURE.md) plus the shapes of the portal's own JSON routes.
// Type-only module: safe to import from client components.
import type { WorkspaceStatus } from "@portal/db";

export interface WorkspaceInfo {
  userId: number;
  status: WorkspaceStatus;
  /** The agent (the Qwen Code Web Shell) answered its health check. */
  ready: boolean;
  startedAt: number | null;
  lastActivityAt: number | null;
  /** null when not running. */
  idleSeconds: number | null;
  /** From docker stats; null when not running or unknown. */
  memoryBytes: number | null;
  /** Open agent WebSockets right now. */
  connections: { owner: number; admin: number };
  llmInFlight: number;
  /** The agent is working: a turn in progress, an LLM request, or sustained CPU. Never idle-stopped. */
  busy: boolean;
  busyReason: "task" | "llm" | "cpu" | null;
  /** Nobody uses it any more but it is still working; it stops once the work is done. */
  stopPending: boolean;
  /** "logout" | "idle" | "admin" | "capacity" | "sessions_expired" | "error" | ... */
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

/** GET /api/workspace/status and POST /api/workspace/start. */
export interface WorkspaceStatusResponse extends WorkspaceInfo {
  /** Whose workspace this session uses (the gateway routes the iframe there). */
  targetUserId: number;
  /** True when an admin is viewing someone else's workspace. */
  actingAs: boolean;
}

/** GET /api/admin/overview. Either part is null when the gateway could not provide it. */
export interface AdminOverview {
  workspaces: WorkspaceInfo[] | null;
  stats: HostStats | null;
  error: ApiError | null;
}
