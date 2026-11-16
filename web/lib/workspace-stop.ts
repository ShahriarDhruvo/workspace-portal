// When the user's own Stop (or "Restart now") asks first. A stop is immediate, even mid-task, so the pages confirm
// when it would cut work short or pull the workspace from under someone. Pure; unit tested.
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

/** Whether to confirm before stopping: anything at all would be interrupted. */
export function stopNeedsConfirm(warnings: StopWarnings): boolean {
  return warnings.busy || warnings.openElsewhere || warnings.admin;
}
