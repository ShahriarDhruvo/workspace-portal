import "server-only";
import { gateway, toApiError } from "./gateway";
import type { AdminAgents, AdminOverview } from "./gateway-types";

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

/** The agents' versions and the update job for the Agents page; null with the error when the gateway can't say. */
export async function loadAdminAgents(options: { refresh?: boolean } = {}): Promise<AdminAgents> {
  try {
    return { versions: await gateway.agentVersions(options), error: null };
  } catch (error) {
    return { versions: null, error: toApiError(error) };
  }
}
