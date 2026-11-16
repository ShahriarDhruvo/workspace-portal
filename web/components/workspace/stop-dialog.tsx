"use client";

import { useState, type RefObject } from "react";
import { returnFocus } from "@/lib/focus";
import type { StopWarnings } from "@/lib/workspace-stop";
import { FormError } from "@/components/forms/form-error";
import { SubmitButton } from "@/components/forms/submit-button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BusyWarning } from "./busy-warning";

interface StopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "stop": the user's Stop; "restart": Settings' "Restart now" (a stop, then a start with the new harness). */
  kind: "stop" | "restart";
  /** What the stop interrupts (lib/workspace-stop.ts); the dialog follows them while open. */
  warnings: StopWarnings;
  /** Stops (or restarts) the workspace; resolves to an error message, or null once done. */
  onConfirm: () => Promise<string | null>;
  /** The button that opened it, which gets the focus back when the dialog closes without stopping. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

const COPY = {
  stop: { title: "Stop your workspace?", effect: "Stopping ends it mid-way.", confirm: "Stop", pending: "Stopping…" },
  restart: { title: "Restart your workspace?", effect: "Restarting ends it mid-way.", confirm: "Restart", pending: "Restarting…" },
} as const;

/**
 * Confirms the user's own stop when it would interrupt something: the agent's task, the workspace open in another
 * tab or on another device, an administrator in it. Files are kept either way. Closes itself once done.
 */
export function StopDialog({ open, onOpenChange, kind, warnings, onConfirm, returnFocusTo }: StopDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <StopForm kind={kind} warnings={warnings} onConfirm={onConfirm} onDone={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's body; it unmounts with the dialog, so an error from an earlier try is gone when it reopens. */
function StopForm({ kind, warnings, onConfirm, onDone }: Pick<StopDialogProps, "kind" | "warnings" | "onConfirm"> & { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[kind];

  async function confirm() {
    const problem = await onConfirm();
    if (problem) setError(problem);
    else onDone();
  }

  return (
    <form action={confirm} className="grid gap-4">
      <AlertDialogHeader>
        <AlertDialogTitle>{copy.title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="flex flex-col gap-2">
            {warnings.busy ? (
              <p>
                <BusyWarning whose="Your" effect={copy.effect} />
              </p>
            ) : null}
            {warnings.openElsewhere ? (
              <p>
                It is also <strong className="font-medium text-warning">open in another tab or on another device</strong>,
                where it stops too.
              </p>
            ) : null}
            {warnings.admin ? <p>An administrator has it open as well.</p> : null}
            <p>Files in the workspace are kept.</p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error ? <FormError>{error}</FormError> : null}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <SubmitButton variant="destructive" pendingLabel={copy.pending}>
          {copy.confirm}
        </SubmitButton>
      </AlertDialogFooter>
    </form>
  );
}
