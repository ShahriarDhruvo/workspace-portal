// What the confirmation of the user's own Stop (or "Restart now") warns about: a stop is immediate, even mid-task,
// so every one asks first and says when it would cut work short or pull the workspace from under someone. And what
// "Restart now" starts again. Pure; unit tested.
import type { WorkspaceKind } from "@portal/core";
import type { WorkspaceInfo } from "./gateway-types.ts";

export interface StopWarnings {
  /** The agent is working on a task: the stop ends it mid-way. */
  busy: boolean;
  /** Another browser or device of the user has it open. */
  openElsewhere: boolean;
  /** An administrator has it open. */
  admin: boolean;
}

/**
 * What a stop would interrupt. `openHere`: the page asking has the workspace open itself (the workspace page,
 * whose own session is one of the owner connections); Home and Settings don't.
 */
export function stopWarnings(info: Pick<WorkspaceInfo, "busy" | "connections">, openHere: boolean): StopWarnings {
  return {
    busy: info.busy,
    openElsewhere: info.connections.owner > (openHere ? 1 : 0),
    admin: info.connections.admin > 0,
  };
}

/**
 * The kind "Restart now" starts again: the one starting or running when the action runs, else none. A workspace
 * that stopped since Settings rendered stays stopped, so a restart never starts a kind the user didn't choose on
 * Home (Online among them).
 */
export function restartKind(info: Pick<WorkspaceInfo, "status" | "kind">): WorkspaceKind | null {
  return info.status === "starting" || info.status === "running" ? info.kind : null;
}
