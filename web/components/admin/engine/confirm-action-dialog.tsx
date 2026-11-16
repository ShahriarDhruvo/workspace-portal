"use client";

import { useState, type ReactNode, type RefObject } from "react";
import type { EngineActionResult } from "@/lib/actions/engine";
import { returnFocus } from "@/lib/focus";
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

interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What the action does and costs. */
  children: ReactNode;
  confirm: string;
  pending: string;
  destructive?: boolean;
  /** Runs the server action; the dialog closes once it succeeded and shows its error otherwise. */
  onConfirm: () => Promise<EngineActionResult>;
  /** The gateway accepted: poll now. */
  onDone: () => void;
  /** Gets the focus when the dialog closes: the control that opened it (the dialog has no Trigger of its own). */
  returnFocusTo: RefObject<HTMLElement | null>;
}

/** Confirms one LLM engine action (update, rollback, restart now, remove an image) and runs it. */
export function ConfirmActionDialog({ open, onOpenChange, returnFocusTo, ...props }: ConfirmActionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <ConfirmForm {...props} onClose={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's body; it unmounts with the dialog, so an error from an earlier try is gone when it reopens. */
function ConfirmForm({
  title,
  children,
  confirm,
  pending,
  destructive = false,
  onConfirm,
  onDone,
  onClose,
}: Omit<ConfirmActionDialogProps, "open" | "onOpenChange" | "returnFocusTo"> & { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const result = await onConfirm();
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
    onDone();
  }

  return (
    <form action={submit} className="grid gap-4">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="flex flex-col gap-2">{children}</div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error ? <FormError>{error}</FormError> : null}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <SubmitButton variant={destructive ? "destructive" : "default"} className="max-w-full min-w-16 shrink" pendingLabel={pending}>
          <span className="truncate">{confirm}</span>
        </SubmitButton>
      </AlertDialogFooter>
    </form>
  );
}
