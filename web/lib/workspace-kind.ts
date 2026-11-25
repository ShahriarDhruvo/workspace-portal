// A user's workspaces in the browser: which kind a Start offers first, why Online can't be chosen, which workspace
// holds a container, and what a refused start says.
import {
  workspaceName,
  workspaceOf,
  type ApiError,
  type OnlineAccess,
  type WorkspaceInfo,
  type WorkspaceKind,
  type WorkspaceRef,
  type WorkspaceStatus,
} from "@portal/core/wire";

/**
 * A workspace's container exists: starting, running or stopping. Its files can't be erased then, and no other
 * workspace of its user starts.
 */
export function hasContainer(status: WorkspaceStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

/**
 * The one of a user's workspaces whose container exists (hasContainer); null when none does: `agent` and `kind` then
 * only name the workspace used last.
 */
export function runningWorkspace(info: Pick<WorkspaceInfo, "status" | "agent" | "kind">): WorkspaceRef | null {
  return hasContainer(info.status) ? workspaceOf(info) : null;
}

const ONLINE_BLOCKED: Readonly<Record<Exclude<OnlineAccess, "allowed">, string>> = {
  off: "Online workspaces are turned off on this portal.",
  not_allowed: "Online workspaces aren't enabled for this account.",
};

/** Why Online can't be chosen, in a few words for a tooltip; null when it can. */
export function onlineBlockedReason(online: OnlineAccess): string | null {
  return online === "allowed" ? null : ONLINE_BLOCKED[online];
}

/**
 * The kind the Private and Online picker starts on: Online whenever it may start (the user's own default), except
 * after a failed start, which offers that kind again.
 */
export function initialKind(info: Pick<WorkspaceInfo, "status" | "kind" | "online">): WorkspaceKind {
  if (info.online !== "allowed") return "private";
  return info.status === "error" ? info.kind : "online";
}

/** What a refused Online start says about Online access ("off" or "not_allowed"); null for other refusals. */
export function onlineAccessAfter(error: Pick<ApiError, "error">): Exclude<OnlineAccess, "allowed"> | null {
  if (error.error === "online_disabled") return "off";
  if (error.error === "online_not_allowed") return "not_allowed";
  return null;
}

/**
 * What a refused start says. `whose` names the workspaces' owner ("Your", "Ada Lovelace's"); `running` is the one of
 * them that holds a container now (runningWorkspace of a status read after the refusal), null when unknown. Anything
 * the portal has no words for keeps the gateway's own message.
 */
export function startErrorText(error: ApiError, whose: string, running: WorkspaceRef | null): string {
  switch (error.error) {
    case "capacity":
      return "All workspace slots are busy. Try again in a minute.";
    case "another_running":
      return running ? `${whose} ${workspaceName(running)} workspace is running. Stop it before starting another.` : error.message;
    default: {
      const online = onlineAccessAfter(error);
      return online ? ONLINE_BLOCKED[online] : error.message;
    }
  }
}
