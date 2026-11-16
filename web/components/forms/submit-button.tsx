"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface SubmitButtonProps extends Omit<ComponentProps<typeof Button>, "type" | "asChild"> {
  /** Label while the form's action runs (defaults to the normal label). */
  pendingLabel?: ReactNode;
  icon?: ReactNode;
  /**
   * Whether the action runs, for a form that dispatches it from onSubmit (useActionState's isPending), where
   * useFormStatus can't see it. Without it, the form's own status.
   */
  pending?: boolean;
}

/** A form's submit Button: while the form is pending it is disabled and busy, and a spinner takes the icon's place. */
export function SubmitButton({ children, pendingLabel, icon, disabled, pending: dispatched, ...props }: SubmitButtonProps) {
  const status = useFormStatus();
  const pending = dispatched ?? status.pending;
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending || undefined} {...props}>
      {pending ? <Spinner aria-hidden="true" /> : icon}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
