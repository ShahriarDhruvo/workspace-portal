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

/**
 * The workspace's state as a pill with a status dot, announced as a status. Its label is cut short when a
 * `className` lets it shrink.
 */
export function StatusPill({ state, title, className }: { state: WorkspaceState; title?: string; className?: string }) {
  const label = state.activity ? `${state.label} · ${state.activity}` : state.label;
  return (
    <Badge role="status" aria-label={`Workspace: ${label}`} title={title} variant={VARIANTS[state.tone]} className={className}>
      <StatusDot tone={state.tone} pulse={state.pulse} />
      <span className="truncate">{label}</span>
    </Badge>
  );
}
