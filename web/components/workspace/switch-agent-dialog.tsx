"use client";

import { useState } from "react";
import type { WorkspaceInfo } from "@/lib/gateway-types";
import { buttonClass } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { BusyWarning } from "./busy-warning";

interface SwitchAgentDialogProps {
  /** Live workspace state: the warnings follow it while the dialog is open. */
  info: Pick<WorkspaceInfo, "busy" | "connections">;
  /** Stops the workspace; resolves to an error message, or null once it is stopped. */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}

/**
 * Confirms "Switch agent": the user's workspace stops at once, even mid-task, then the page offers the agents
 * again. Warns when the agent is working and when another session has the workspace open; an administrator
 * viewing it is mentioned on its own. Mount to open; `onClose` should unmount it.
 */
export function SwitchAgentDialog({ info, onConfirm, onClose }: SwitchAgentDialogProps) {
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    const problem = await onConfirm();
    if (problem) setError(problem);
    else onClose();
  }

  return (
    <Dialog title="Switch agent" onClose={onClose}>
      <form action={confirm} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 text-14 text-fg-muted">
          {info.busy ? (
            <p>
              <BusyWarning whose="Your" effect="Switching ends it mid-way." />
            </p>
          ) : null}
          <p>Your workspace stops, then you choose which agent to start. Files in the workspace are kept.</p>
          {info.connections.owner > 1 ? (
            <p>
              It is also <strong className="font-medium text-warning">open in another browser or on another device</strong>,
              where it stops too.
            </p>
          ) : null}
          {info.connections.admin > 0 ? <p>An administrator has it open as well.</p> : null}
        </div>
        {error ? <FormError>{error}</FormError> : null}
        <DialogFooter>
          <button type="button" className={buttonClass("outline", "sm")} onClick={onClose}>
            Cancel
          </button>
          <SubmitButton size="sm" className="min-w-16" pendingLabel="Stopping…">
            Stop and switch
          </SubmitButton>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
