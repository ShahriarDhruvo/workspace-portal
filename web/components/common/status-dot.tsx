import { cn } from "@/lib/utils";

export type DotTone = "success" | "warning" | "danger" | "idle";

/** Text colour too, so the pulse ring (drawn in currentColor) matches the dot. */
const DOT_TONES: Record<DotTone, string> = {
  success: "bg-success text-success",
  warning: "bg-warning text-warning",
  danger: "bg-danger text-danger",
  idle: "bg-idle text-idle",
};

/** A 6px status dot; `pulse` breathes a soft ring around it while something is in progress. */
export function StatusDot({ tone, pulse = false }: { tone: DotTone; pulse?: boolean }) {
  return (
    <span aria-hidden="true" className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_TONES[tone], pulse && "activity-pulse")} />
  );
}
