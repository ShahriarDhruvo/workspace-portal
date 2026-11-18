import "server-only";
import { after } from "next/server";
import type {
  AgentInfo,
  AgentKind,
  AgentUpdateJob,
  AgentUpdateRequest,
  AgentVersionsOverview,
  ApiError,
  EnergyPriceStatus,
  EngineOverview,
  EngineUpdateJob,
  HostStats,
  StopReason,
  WorkspaceInfo,
  WorkspaceKind,
} from "@portal/core";
import { config } from "./config";
import type { DeletedSessions } from "./session-store";
import type { ActionResult } from "./validation";

// Client for the gateway control API (docs/ARCHITECTURE.md, "Gateway control API").

const DEFAULT_TIMEOUT_MS = 5_000;
/** Start returns once the container is created; it may first evict an idle workspace (docker stop -t 10). */
const START_TIMEOUT_MS = 30_000;
/** Stop, release and data deletion include `docker stop -t 10`. */
const STOP_TIMEOUT_MS = 30_000;
/**
 * Calls that may wait on the registries (the versions overviews when their 10-minute cache is stale or a refresh is
 * asked for, and an update, which resolves the version first). The gateway gives each request 10 s, and a check can
 * chain several: npm then GitHub for an agent; the engine registry's token challenge, the tag list, then digests and
 * GitHub together. Normally a second; this only bounds a very slow registry, which must not read as the gateway
 * being down.
 */
const REGISTRY_TIMEOUT_MS = 45_000;
/** Removing an image is Docker deleting its layers. */
const IMAGE_REMOVE_TIMEOUT_MS = 30_000;

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

function errorBody(payload: unknown): Partial<ApiError> {
  if (payload === null || typeof payload !== "object") return {};
  const { error, message } = payload as Record<string, unknown>;
  return {
    error: typeof error === "string" ? error : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

type Method = "GET" | "POST" | "DELETE";

/** One control request; no answer, or a refusal, is a GatewayError. */
async function send(method: Method, path: string, options: { body?: unknown; signal: AbortSignal; accept?: string }): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.controlSecret}`, accept: options.accept ?? "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.controlPort}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new GatewayError(504, "timeout", "The workspace service did not answer in time.");
    }
    throw new GatewayError(502, "unreachable", "The workspace service is not reachable.");
  }
  if (!response.ok) {
    const body = errorBody(await response.json().catch(() => null));
    throw new GatewayError(
      response.status,
      body.error ?? "gateway_error",
      body.message ?? `The workspace service answered with HTTP ${response.status}.`,
    );
  }
  return response;
}

async function call<T>(method: Method, path: string, options: { body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const response = await send(method, path, { body: options.body, signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  return (await response.json().catch(() => null)) as T;
}

export const gateway = {
  /** The live view's event stream (docs/ARCHITECTURE.md, "Live view"), open until `signal` aborts. */
  live: (signal: AbortSignal) => send("GET", "/control/live", { signal, accept: "text/event-stream" }),
  stats: () => call<HostStats>("GET", "/control/stats"),
  /** The agents enabled on this install, in display order. */
  agents: async (timeoutMs?: number) =>
    (await call<{ agents: AgentInfo[] }>("GET", "/control/agents", timeoutMs ? { timeoutMs } : {})).agents,
  listWorkspaces: async () => (await call<{ workspaces: WorkspaceInfo[] }>("GET", "/control/workspaces")).workspaces,
  getWorkspace: (userId: number, timeoutMs?: number) =>
    call<WorkspaceInfo>("GET", `/control/workspaces/${userId}`, timeoutMs ? { timeoutMs } : {}),
  /**
   * Creates and starts the `kind` container with the user's harness (their choice in Settings while it is enabled,
   * else the first enabled agent), then returns (status "starting"); poll getWorkspace until ready. An already
   * starting or running workspace of that kind just returns its state, whatever its agent, and calls off a pending
   * stop. Without `kind`: attaches to a starting or running workspace of either kind, else starts Private.
   * Errors: 409 `capacity` when every slot is busy; 409 `kind_mismatch` while the other kind runs (stop it first);
   * 409 `online_disabled` (ONLINE_WORKSPACES=off) and 403 `online_not_allowed` (the admin barred this user).
   */
  start: (userId: number, kind?: WorkspaceKind, timeoutMs = START_TIMEOUT_MS) =>
    call<WorkspaceInfo>("POST", `/control/workspaces/${userId}/start`, { body: kind ? { kind } : {}, timeoutMs }),
  /** The gateway writes the `workspace_stopped` audit entry, attributed to `actorUserId`. */
  stop: (userId: number, reason: StopReason, actorUserId?: number) =>
    call<WorkspaceInfo>("POST", `/control/workspaces/${userId}/stop`, {
      body: { reason, actorUserId },
      timeoutMs: STOP_TIMEOUT_MS,
    }),
  /** A session started using the workspace: calls off a pending stop if it is starting or running. Never starts it. */
  attach: (userId: number) => call<WorkspaceInfo>("POST", `/control/workspaces/${userId}/attach`),
  /** Stops the workspace only if no session uses it any more. */
  release: (userId: number) =>
    call<WorkspaceInfo>("POST", `/control/workspaces/${userId}/release`, { timeoutMs: STOP_TIMEOUT_MS }),
  /** Closes the agent connections of one session (`sessionId` = the sessions.id hash). */
  disconnect: (sessionId: string) =>
    call<{ closed: number }>("POST", `/control/sessions/${encodeURIComponent(sessionId)}/disconnect`),
  /**
   * Erases one kind's files (its home and workspace folders, left empty): 409 `workspace_running` while that kind
   * is starting, running or stopping. The gateway writes the `workspace_files_erased` audit entry.
   */
  eraseFiles: (userId: number, kind: WorkspaceKind, actorUserId?: number) =>
    call<{ ok: true }>("DELETE", `/control/workspaces/${userId}/files?kind=${kind}`, {
      body: { actorUserId },
      timeoutMs: STOP_TIMEOUT_MS,
    }),
  deleteData: (userId: number) =>
    call<{ ok: true }>("DELETE", `/control/workspaces/${userId}/data`, { timeoutMs: STOP_TIMEOUT_MS }),
  /** The electricity price downloads' state (EIA, Eurostat): answers at once. */
  energyPrices: () => call<EnergyPriceStatus>("GET", "/control/energy-prices"),
  /**
   * Downloads the electricity prices now (a source downloaded in the last 10 minutes is skipped) and answers once
   * they are stored: Settings, when the admin picks a place that has none yet.
   */
  refreshEnergyPrices: () => call<EnergyPriceStatus>("POST", "/control/energy-prices/refresh", { timeoutMs: REGISTRY_TIMEOUT_MS }),
  /** The enabled agents' versions, their Package images rows and the running or last update job. */
  agentVersions: ({ refresh = false }: { refresh?: boolean } = {}) =>
    call<AgentVersionsOverview>("GET", `/control/agents/versions${refresh ? "?refresh=1" : ""}`, {
      timeoutMs: REGISTRY_TIMEOUT_MS,
    }),
  /**
   * Starts building `request.version` of the agent and returns the job as it starts (one job at a time, for all
   * agents: 409 `update_running`). The gateway audits the outcome, attributed to `actorUserId`.
   */
  updateAgent: (agent: AgentKind, request: AgentUpdateRequest) =>
    call<AgentUpdateJob>("POST", `/control/agents/${agent}/update`, { body: request, timeoutMs: REGISTRY_TIMEOUT_MS }),
  /** false: no job runs, or it is already making the new image current. */
  cancelAgentUpdate: () => call<{ cancelled: boolean }>("POST", "/control/agents/update/cancel"),
  /** Refused for the current version's image, one a container uses, and while that agent is being updated. */
  removeAgentImage: (agent: AgentKind, version: string) =>
    call<{ ok: true }>("DELETE", `/control/agents/${agent}/images/${encodeURIComponent(version)}`, {
      timeoutMs: IMAGE_REMOVE_TIMEOUT_MS,
    }),
  /**
   * The LLM engine: what runs, its releases and their notes, and the running or last update job
   * (docs/ARCHITECTURE.md, "LLM engine updates"). `refresh` asks the registry and GitHub again.
   */
  engine: ({ refresh = false }: { refresh?: boolean } = {}) =>
    call<EngineOverview>("GET", `/control/engine${refresh ? "?refresh=1" : ""}`, { timeoutMs: REGISTRY_TIMEOUT_MS }),
  /** Starts updating the engine to an exact release (resolved to its digest first). The gateway audits the outcome. */
  updateEngine: (version: string, actorUserId: number) =>
    call<EngineUpdateJob>("POST", "/control/engine/update", { body: { version, actorUserId }, timeoutMs: REGISTRY_TIMEOUT_MS }),
  /** false: too late (restarting or finished). */
  cancelEngineUpdate: () => call<{ cancelled: boolean }>("POST", "/control/engine/cancel"),
  /** Ends the drain: restarts even though requests still run (they are cut off). false: not draining. */
  restartEngineNow: () => call<{ ok: boolean }>("POST", "/control/engine/restart-now"),
  /** Refused for the image the engine runs and while a job runs. */
  removeEngineImage: (digest: string) =>
    call<{ ok: true }>("DELETE", `/control/engine/images/${encodeURIComponent(digest)}`, { timeoutMs: IMAGE_REMOVE_TIMEOUT_MS }),
};

// The one place that turns failures into words: toApiError for people (JSON routes, pages, dialogs),
// describeError for the server log.

/** What to tell the user: the gateway's own message, or a generic one for anything else (logged). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof GatewayError) return { error: error.code, message: error.message };
  console.error("[portal] unexpected error:", error);
  return { error: "internal", message: "Something went wrong in the portal." };
}

/** A server action's gateway work: done, or the failure as `words` puts it. */
export async function attempt(work: () => Promise<unknown>, words = (error: ApiError) => error.message): Promise<ActionResult> {
  try {
    await work();
  } catch (error) {
    return { ok: false, message: words(toApiError(error)) };
  }
  return { ok: true };
}

/** One log line with the gateway's code and status. */
export function describeError(error: unknown): string {
  if (error instanceof GatewayError) return `${error.code} (${error.status}): ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Runs gateway calls after the response has been sent. Failures are logged, never thrown. */
function afterResponse(label: string, task: () => Promise<unknown>): void {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error(`[gateway] ${label} failed: ${describeError(error)}`);
    }
  });
}

/**
 * A session has just started using this workspace (sign-in, an admin opening it). Without waiting for it, attaches
 * to the workspace: a starting or running one's pending stop is off. A stopped workspace stays stopped: starting it
 * is always the person's Start button.
 */
export function attachWorkspaceInBackground(userId: number): void {
  afterResponse(`attach workspace ${userId}`, () => gateway.attach(userId));
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
