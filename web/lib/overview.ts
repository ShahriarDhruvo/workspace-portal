import "server-only";
import { toApiError } from "./api";
import { gateway } from "./gateway";
import type { AdminOverview } from "./gateway-types";

/** Workspaces and host stats for the admin dashboard; whatever the gateway can't provide is null. */
export async function loadAdminOverview(): Promise<AdminOverview> {
  const [workspaces, stats] = await Promise.allSettled([gateway.listWorkspaces(), gateway.stats()]);
  const failure = workspaces.status === "rejected" ? workspaces.reason : stats.status === "rejected" ? stats.reason : null;
  return {
    workspaces: workspaces.status === "fulfilled" ? workspaces.value : null,
    stats: stats.status === "fulfilled" ? stats.value : null,
    error: failure === null ? null : toApiError(failure),
  };
}
