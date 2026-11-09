import type { ReactNode } from "react";

// Web Shell badge (20px pill, 12px/500) and status dot. Status tones are the tone's text on a 14% tint of
// itself, as on the Daemon Status page; "solid" is the light-grey primary, "outline" a 1px border.

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "outline" | "solid";

const TAG_TONES: Record<Tone, string> = {
  success: "bg-success/14 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-danger/14 text-danger",
  info: "bg-info/14 text-info",
  neutral: "bg-fg-muted/14 text-fg-muted",
  outline: "border border-line text-fg-muted",
  solid: "bg-primary text-fg-on-primary",
};

export function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded-full px-2 text-12 font-medium whitespace-nowrap ${TAG_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export type DotTone = "success" | "warning" | "danger" | "idle";

/** Text colour too, so the pulse ring (drawn in currentColor) matches the dot. */
const DOT_TONES: Record<DotTone, string> = {
  success: "bg-success text-success",
  warning: "bg-warning text-warning",
  danger: "bg-danger text-danger",
  idle: "bg-idle text-idle",
};

export function StatusDot({ tone, pulse = false }: { tone: DotTone; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-1.5 shrink-0 rounded-full ${DOT_TONES[tone]} ${pulse ? "activity-pulse" : ""}`}
    />
  );
}
