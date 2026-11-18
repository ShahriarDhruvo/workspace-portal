"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import { returnFocus } from "@/lib/focus";
import type { ActionResult } from "@/lib/validation";
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

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What the action does and costs. */
  children: ReactNode;
  /** The description sits under the header (left-aligned on a phone) instead of in it. */
  apart?: boolean;
  confirm: string;
  pending: string;
  destructive?: boolean;
  /** Runs the server action; the dialog closes once it succeeded and shows its error otherwise. */
  onConfirm: () => Promise<ActionResult>;
  onDone: () => void;
  /** Gets the focus when the dialog closes: the control that opened it (the dialog has no Trigger of its own). */
  returnFocusTo: RefObject<HTMLElement | null>;
}

/** Confirms one action and runs it. */
export function ConfirmDialog({ open, onOpenChange, returnFocusTo, ...props }: ConfirmDialogProps) {
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
  apart = false,
  confirm,
  pending,
  destructive = false,
  onConfirm,
  onDone,
  onClose,
}: Omit<ConfirmDialogProps, "open" | "onOpenChange" | "returnFocusTo"> & { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  async function submit() {
    const result = await onConfirm();
    // Closed while the action ran: its answer is nobody's any more.
    if (!form.current) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
    onDone();
  }

  const description = (
    <AlertDialogDescription asChild>
      <div className="flex flex-col gap-2">{children}</div>
    </AlertDialogDescription>
  );
  return (
    <form ref={form} action={submit} className="grid gap-4">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {apart ? null : description}
      </AlertDialogHeader>
      {apart ? description : null}
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
