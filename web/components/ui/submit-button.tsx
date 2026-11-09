"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button";

interface SubmitButtonProps {
  children: ReactNode;
  /** Label while the form's action runs (defaults to the normal label). */
  pendingLabel?: ReactNode;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
}

/** Submit button that disables itself and shows a spinner while its form is pending. */
export function SubmitButton({
  children,
  pendingLabel,
  icon,
  variant = "primary",
  size = "md",
  className = "",
  disabled,
  name,
  value,
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending || disabled}
      data-pending={pending ? "" : undefined}
      aria-busy={pending || undefined}
      className={buttonClass(variant, size, className)}
    >
      {pending ? (
        <span aria-hidden="true" className="spinner [--spinner-size:1em] [--spinner-width:1.5px]" />
      ) : (
        icon
      )}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
