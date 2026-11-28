"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface SubmitButtonProps extends Omit<ComponentProps<typeof Button>, "type" | "asChild"> {
  /** Label while the form's action runs (defaults to the normal label). */
  pendingLabel?: ReactNode;
  icon?: ReactNode;
}

/**
 * A form's submit Button: while the form is pending it looks disabled, is busy and submits nothing, and a spinner
 * takes the icon's place. It stays focusable then (aria-disabled rather than disabled), so that the focus is still
 * on it, not on the page, when the action fails.
 */
export function SubmitButton({ children, pendingLabel, icon, className, onClick, ...props }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      {...props}
      onClick={(event) => {
        if (pending) event.preventDefault();
        else onClick?.(event);
      }}
      className={cn(pending && "opacity-50 active:translate-y-0", className)}
    >
      {pending ? <Spinner aria-hidden="true" /> : icon}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
