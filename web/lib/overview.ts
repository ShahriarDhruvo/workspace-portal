import "server-only";
import type { ApiError, HostStats, WorkspaceInfo } from "@portal/core/wire";
import { gateway, toApiError } from "./gateway";
import type { Loaded } from "./update-jobs";

/** GET /api/admin/overview. Either part is null when the gateway could not provide it. */
export interface AdminOverview {
  /** When it was read (epoch ms, the portal server's clock, which the gateway shares), for "Up for". */
  t: number;
  workspaces: WorkspaceInfo[] | null;
  stats: HostStats | null;
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

/** A gateway read for the Updates page (/api/admin/agents, /api/admin/engine); null with the error when it can't say. */
export async function loaded<T>(read: Promise<T>): Promise<Loaded<T>> {
  try {
    return { data: await read, error: null };
  } catch (error) {
    return { data: null, error: toApiError(error) };
  }
}
