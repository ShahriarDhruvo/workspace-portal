import type { ComponentProps, ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface FormFieldProps extends Omit<ComponentProps<typeof Input>, "name"> {
  label: string;
  name: string;
  /** The server's message for this field: shown under it, and the input turns red (aria-invalid). */
  error?: string;
  /** Help that stays visible, under the input. A placeholder is only an example, never the label. */
  hint?: ReactNode;
  optional?: boolean;
  /** Rendered after the input on the same row (e.g. a Generate button). */
  addon?: ReactNode;
  /** Monospace text, for generated secrets. */
  mono?: boolean;
}

/** A labelled text input with its hint and error, on the shadcn/ui Field parts. The input points at both. */
export function FormField({ label, name, error, hint, optional, addon, mono, id, className, ...input }: FormFieldProps) {
  const inputId = id ?? `field-${name}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const control = (
    <Input
      id={inputId}
      name={name}
      aria-invalid={error ? true : undefined}
      aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
      className={cn(mono && "font-mono", className)}
      {...input}
    />
  );
  return (
    <Field>
      <FieldLabel htmlFor={inputId}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
      </FieldLabel>
      {addon ? (
        <div className="flex items-center gap-2">
          {control}
          {addon}
        </div>
      ) : (
        control
      )}
      {hint ? <FieldDescription id={hintId}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}
