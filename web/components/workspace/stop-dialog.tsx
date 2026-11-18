"use client";

import type { RefObject } from "react";
import type { ActionResult } from "@/lib/validation";
import type { StopWarnings } from "@/lib/workspace-stop";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { BusyWarning } from "./busy-warning";

interface StopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "stop": the user's Stop; "restart": Settings' "Restart now" (a stop, then a start with the new harness). */
  kind: "stop" | "restart";
  /** What the stop interrupts (lib/workspace-stop.ts); the dialog follows them while open. */
  warnings: StopWarnings;
  /** Stops (or restarts) the workspace. */
  onConfirm: () => Promise<ActionResult>;
  /** The button that opened it, which gets the focus back when the dialog closes without stopping. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

const COPY = {
  stop: { title: "Stop your workspace?", effect: "Stopping ends it mid-way.", confirm: "Stop", pending: "Stopping…" },
  restart: { title: "Restart your workspace?", effect: "Restarting ends it mid-way.", confirm: "Restart", pending: "Restarting…" },
} as const;

/**
 * Confirms every stop (and restart) of the user's own workspace, and says what it would interrupt: the agent's task,
 * the workspace open in another tab or on another device, an administrator in it. Files are kept either way.
 * Closes itself once done.
 */
export function StopDialog({ kind, warnings, ...dialog }: StopDialogProps) {
  const copy = COPY[kind];
  return (
    <ConfirmDialog {...dialog} title={copy.title} confirm={copy.confirm} pending={copy.pending} destructive onDone={() => {}}>
      {warnings.busy ? (
        <p>
          <BusyWarning whose="Your" effect={copy.effect} />
        </p>
      ) : null}
      {warnings.openElsewhere ? (
        <p>
          It is also <strong className="font-medium text-warning">open in another tab or on another device</strong>, where it
          stops too.
        </p>
      ) : null}
      {warnings.admin ? <p>An administrator has it open as well.</p> : null}
      <p>Files in the workspace are kept.</p>
    </ConfirmDialog>
  );
}
