// The two kinds of workspace in the browser: their names, which one a Start offers first, why Online can't be
// chosen, and what a refused start says. Pure (client components can't import values from @portal/db); unit
// tested, including that the names match WORKSPACE_KIND_NAMES.
import type { WorkspaceKind, WorkspaceStatus } from "@portal/db";
import type { ApiError, OnlineAccess, WorkspaceInfo } from "./gateway-types.ts";

/** WORKSPACE_KIND_NAMES, for client components. */
export const KIND_NAMES: Readonly<Record<WorkspaceKind, string>> = { private: "Private", online: "Online" };

export function otherKind(kind: WorkspaceKind): WorkspaceKind {
  return kind === "online" ? "private" : "online";
}

/** A container of that kind exists: starting, running or stopping. Its files can't be erased then. */
export function hasContainer(status: WorkspaceStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
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
 * What a refused start says. `kind` is the one asked for; `whose` names the workspace's owner ("Your", "Ada
 * Lovelace's"). Anything else keeps the gateway's own message.
 */
export function startErrorText(error: ApiError, kind: WorkspaceKind, whose: string): string {
  switch (error.error) {
    case "capacity":
      return "All workspace slots are busy. Try again in a minute.";
    case "kind_mismatch":
      return `${whose} ${KIND_NAMES[otherKind(kind)]} workspace is running. Stop it before starting the ${KIND_NAMES[kind]} one.`;
    default: {
      const online = onlineAccessAfter(error);
      return online ? ONLINE_BLOCKED[online] : error.message;
    }
  }
}
