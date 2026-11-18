"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface SubmitButtonProps extends Omit<ComponentProps<typeof Button>, "type" | "asChild"> {
  /** Label while the form's action runs (defaults to the normal label). */
  pendingLabel?: ReactNode;
  icon?: ReactNode;
}

/** A form's submit Button: while the form is pending it is disabled and busy, and a spinner takes the icon's place. */
export function SubmitButton({ children, pendingLabel, icon, disabled, ...props }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending || undefined} {...props}>
      {pending ? <Spinner aria-hidden="true" /> : icon}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
