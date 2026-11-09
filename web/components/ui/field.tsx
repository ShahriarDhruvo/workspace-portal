import type { InputHTMLAttributes, ReactNode } from "react";

// Web Shell input: 14px/500 label, 32px input (6px radius, white/15% border, white/4.5% fill); focus turns the
// border grey and adds a 3px ring, invalid turns it red. The "login" tone is the Connect card's 44px mono input.

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label: string;
  name: string;
  error?: string;
  hint?: ReactNode;
  optional?: boolean;
  /** "login": the auth card's 44px, 10px-radius monospace input. */
  tone?: "settings" | "login";
  /** Rendered after the input on the same row (e.g. a Generate button). */
  addon?: ReactNode;
  /** Monospace text, for generated secrets. */
  mono?: boolean;
}

const INPUT_CLASS =
  "w-full min-w-0 border border-line-strong bg-input px-2.5 text-14 text-fg outline-none " +
  "transition-[color,border-color,box-shadow] placeholder:text-fg-subtle pointer-coarse:text-16 " +
  "focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/50 " +
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const TONES = {
  settings: "h-8 rounded-md",
  login: "h-11 rounded-xl font-mono",
} as const;

export function Field({ label, name, error, hint, optional, tone = "settings", addon, mono, id, ...input }: FieldProps) {
  const inputId = id ?? `field-${name}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-14 leading-snug font-medium text-fg">
        {label}
        {optional ? <span className="font-normal text-fg-muted"> (optional)</span> : null}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${INPUT_CLASS} ${TONES[tone]} ${mono ? "font-mono" : ""}`}
          {...input}
        />
        {addon}
      </div>
      {error ? (
        <p id={errorId} className="text-13 text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-12 text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Form-level error banner (role="alert" so screen readers announce it). */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-13 text-danger">
      {children}
    </p>
  );
}
