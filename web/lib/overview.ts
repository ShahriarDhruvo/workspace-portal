import "server-only";
import type { AgentVersionsOverview, ApiError, EngineOverview, HostStats, WorkspaceInfo } from "@portal/core/wire";
import { gateway, toApiError } from "./gateway";

/** GET /api/admin/overview. Either part is null when the gateway could not provide it. */
export interface AdminOverview {
  /** When it was read (epoch ms, the portal server's clock, which the gateway shares), for "Up for". */
  t: number;
  workspaces: WorkspaceInfo[] | null;
  stats: HostStats | null;
  error: ApiError | null;
}

/** GET (and POST, refreshing) /api/admin/agents. `versions` is null when the gateway could not provide it. */
export interface AdminAgents {
  versions: AgentVersionsOverview | null;
  error: ApiError | null;
}

/** GET (and POST, refreshing) /api/admin/engine. `engine` is null when the gateway could not provide it. */
export interface AdminEngine {
  engine: EngineOverview | null;
  error: ApiError | null;
}

/** Workspaces and host stats for the admin dashboard; whatever the gateway can't provide is null. */
export async function loadAdminOverview(): Promise<AdminOverview> {
  const [workspaces, stats] = await Promise.allSettled([gateway.listWorkspaces(), gateway.stats()]);
  const failure = workspaces.status === "rejected" ? workspaces.reason : stats.status === "rejected" ? stats.reason : null;
  return {
    t: Date.now(),
    workspaces: workspaces.status === "fulfilled" ? workspaces.value : null,
    stats: stats.status === "fulfilled" ? stats.value : null,
    error: failure === null ? null : toApiError(failure),
  };
}

/** The agents' versions and the update job for the Agents page; null with the error when the gateway can't say. */
export async function loadAdminAgents(options: { refresh?: boolean } = {}): Promise<AdminAgents> {
  try {
    return { versions: await gateway.agentVersions(options), error: null };
  } catch (error) {
    return { versions: null, error: toApiError(error) };
  }
}

/** The LLM engine's versions and update job for the Updates page; null with the error when the gateway can't say. */
export async function loadAdminEngine(options: { refresh?: boolean } = {}): Promise<AdminEngine> {
  try {
    return { engine: await gateway.engine(options), error: null };
  } catch (error) {
    return { engine: null, error: toApiError(error) };
  }
}
