import type { ReactNode } from "react";

/**
 * The warning of the actions that stop a workspace at once, even mid-task: an admin's stop, deactivate and
 * delete, and the user's own "Switch agent". `whose` names the agent's owner ("Your", "Ada's"); `effect` says
 * what the action does to the task.
 */
export function BusyWarning({ whose, effect }: { whose: ReactNode; effect: string }) {
  return (
    <>
      {whose} agent is <strong className="font-medium text-warning">working on a task right now</strong>. {effect}
    </>
  );
}
