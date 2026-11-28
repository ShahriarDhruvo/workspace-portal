import type { WorkspaceState } from "@/lib/format";
import { StatusDot } from "@/components/common/status-dot";
import { Badge } from "@/components/ui/badge";

/** The Badge tone of each state tone: running in the info blue, as the Web Shell marks running sessions. */
const VARIANTS = {
  info: "info",
  warning: "warning",
  danger: "destructive",
  idle: "secondary",
} as const satisfies Record<WorkspaceState["tone"], string>;

interface StatusPillProps {
  state: WorkspaceState;
  title?: string;
  className?: string;
  /** The workspace bar: on a phone a running workspace shows only its activity ("Working"), which fits. */
  compact?: boolean;
}

/**
 * The workspace's state as a pill with a status dot, announced as a status. Its label is cut short when a
 * `className` lets it shrink.
 */
export function StatusPill({ state, title, className, compact = false }: StatusPillProps) {
  const label = state.activity ? `${state.label} · ${state.activity}` : state.label;
  return (
    <Badge role="status" aria-label={`Workspace: ${label}`} title={title} variant={VARIANTS[state.tone]} className={className}>
      <StatusDot tone={state.tone} pulse={state.pulse} />
      <span className="truncate">
        {state.activity ? (
          <>
            <span className={compact ? "max-sm:hidden" : undefined}>{state.label} · </span>
            <span className={compact ? "max-sm:capitalize" : undefined}>{state.activity}</span>
          </>
        ) : (
          state.label
        )}
      </span>
    </Badge>
  );
}
