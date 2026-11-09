import "server-only";
import { after } from "next/server";
import { config } from "./config";
import type { ApiError, HostStats, WorkspaceInfo } from "./gateway-types";
import type { DeletedSessions } from "./session-store";

// Client for the gateway control API (docs/ARCHITECTURE.md, "Gateway control API").

const DEFAULT_TIMEOUT_MS = 5_000;
/** Start returns once the container is created; it may first evict an idle workspace (docker stop -t 10). */
const START_TIMEOUT_MS = 30_000;
/** Stop, release and data deletion include `docker stop -t 10`. */
const STOP_TIMEOUT_MS = 30_000;

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
  }
}

function errorBody(payload: unknown): { error?: string; message?: string } {
  if (payload === null || typeof payload !== "object") return {};
  const { error, message } = payload as Record<string, unknown>;
  return {
    error: typeof error === "string" ? error : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.controlSecret}`, accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.controlPort}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new GatewayError(504, "timeout", "The workspace service did not answer in time.");
    }
    throw new GatewayError(502, "unreachable", "The workspace service is not reachable.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = errorBody(payload);
    throw new GatewayError(
      response.status,
      body.error ?? "gateway_error",
      body.message ?? `The workspace service answered with HTTP ${response.status}.`,
    );
  }
  return payload as T;
}

export const gateway = {
  stats: () => call<HostStats>("GET", "/control/stats"),
  listWorkspaces: async () => (await call<{ workspaces: WorkspaceInfo[] }>("GET", "/control/workspaces")).workspaces,
  getWorkspace: (userId: number, timeoutMs?: number) =>
    call<WorkspaceInfo>("GET", `/control/workspaces/${userId}`, timeoutMs ? { timeoutMs } : {}),
  /** Creates and starts the container, then returns (status "starting"); poll getWorkspace until ready. 409 `capacity` when every slot is busy. */
  start: (userId: number, timeoutMs = START_TIMEOUT_MS) =>
    call<WorkspaceInfo>("POST", `/control/workspaces/${userId}/start`, { timeoutMs }),
  /** The gateway writes the `workspace_stopped` audit entry, attributed to `actorUserId`. */
  stop: (userId: number, reason: string, actorUserId?: number) =>
    call<WorkspaceInfo>("POST", `/control/workspaces/${userId}/stop`, {
      body: { reason, actorUserId },
      timeoutMs: STOP_TIMEOUT_MS,
    }),
  /** Stops the workspace only if no session uses it any more. */
  release: (userId: number) =>
    call<WorkspaceInfo>("POST", `/control/workspaces/${userId}/release`, { timeoutMs: STOP_TIMEOUT_MS }),
  /** Closes the agent connections of one session (`sessionId` = the sessions.id hash). */
  disconnect: (sessionId: string) =>
    call<{ closed: number }>("POST", `/control/sessions/${encodeURIComponent(sessionId)}/disconnect`),
  deleteData: (userId: number) =>
    call<{ ok: true }>("DELETE", `/control/workspaces/${userId}/data`, { timeoutMs: STOP_TIMEOUT_MS }),
};

// The one place that turns failures into words: toApiError for people (JSON routes, pages, dialogs),
// describeError for the server log.

/** What to tell the user: the gateway's own message, or a generic one for anything else (logged). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof GatewayError) return { error: error.code, message: error.message };
  console.error("[portal] unexpected error:", error);
  return { error: "internal", message: "Something went wrong in the portal." };
}

/** One log line with the gateway's code and status. */
export function describeError(error: unknown): string {
  if (error instanceof GatewayError) return `${error.code} (${error.status}): ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Runs gateway calls after the response has been sent. Failures are logged, never thrown. */
export function afterResponse(label: string, task: () => Promise<unknown>): void {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error(`[gateway] ${label} failed: ${describeError(error)}`);
    }
  });
}

/**
 * Asks the gateway to start a workspace without waiting for it. The short timeout only bounds this
 * request; the workspace page polls the status and shows capacity or other errors itself.
 */
export function startInBackground(userId: number): void {
  afterResponse(`start workspace ${userId}`, async () => {
    try {
      await gateway.start(userId, DEFAULT_TIMEOUT_MS);
    } catch (error) {
      // A timeout only means the start takes longer than we wait; capacity is shown by the page.
      if (error instanceof GatewayError && (error.code === "timeout" || error.code === "capacity")) return;
      throw error;
    }
  });
}

/** Releases workspaces whose sessions just ended (each stops only if nothing else uses it). */
export function releaseInBackground(userIds: Iterable<number>): void {
  for (const userId of new Set(userIds)) {
    afterResponse(`release workspace ${userId}`, () => gateway.release(userId));
  }
}

/**
 * The gateway side of deleting sessions. A deleted row only stops new requests; the terminals and event
 * streams a session already has open stay up until it is disconnected. Then the workspaces those
 * sessions used are released (each stops unless another session still uses it).
 */
export function endSessionsInBackground(deleted: DeletedSessions): void {
  for (const sessionId of deleted.sessionIds) {
    afterResponse("disconnect ended session", () => gateway.disconnect(sessionId));
  }
  releaseInBackground(deleted.workspaceUserIds);
}
