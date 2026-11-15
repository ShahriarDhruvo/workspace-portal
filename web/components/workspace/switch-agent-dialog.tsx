"use client";

import { useState, type RefObject } from "react";
import { returnFocus } from "@/lib/focus";
import type { WorkspaceInfo } from "@/lib/gateway-types";
import { FormError } from "@/components/forms/form-error";
import { SubmitButton } from "@/components/forms/submit-button";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BusyWarning } from "./busy-warning";

interface SwitchAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Live workspace state: the warnings follow it while the dialog is open. */
  info: Pick<WorkspaceInfo, "busy" | "connections">;
  /** Stops the workspace; resolves to an error message, or null once it is stopped. */
  onConfirm: () => Promise<string | null>;
  /** The "Switch agent" button, which gets the focus back when the dialog closes without switching. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

/**
 * Confirms "Switch agent": the user's workspace stops at once, even mid-task, then the page offers the agents
 * again. Warns when the agent is working and when another session has the workspace open; an administrator
 * viewing it is mentioned on its own. Closes itself once the workspace has stopped.
 */
export function SwitchAgentDialog({ open, onOpenChange, info, onConfirm, returnFocusTo }: SwitchAgentDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch agent</AlertDialogTitle>
        </AlertDialogHeader>
        <SwitchAgentForm info={info} onConfirm={onConfirm} onDone={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's body; it unmounts with the dialog, so an error from an earlier try is gone when it reopens. */
function SwitchAgentForm({ info, onConfirm, onDone }: Pick<SwitchAgentDialogProps, "info" | "onConfirm"> & { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    const problem = await onConfirm();
    if (problem) setError(problem);
    else onDone();
  }

  return (
    <form action={confirm}>
      <AlertDialogBody>
        <AlertDialogDescription asChild>
          <div className="flex flex-col gap-2">
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
        </AlertDialogDescription>
        {error ? <FormError>{error}</FormError> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <SubmitButton size="sm" className="min-w-16" pendingLabel="Stopping…">
            Stop and switch
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogBody>
    </form>
  );
}
