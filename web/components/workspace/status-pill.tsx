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

/** The workspace's state as a pill with a status dot ("Running · working"), announced as a status. */
export function StatusPill({ state }: { state: WorkspaceState }) {
  const label = state.activity ? `${state.label} · ${state.activity}` : state.label;
  return (
    <Badge role="status" aria-label={`Workspace: ${label}`} variant={VARIANTS[state.tone]}>
      <StatusDot tone={state.tone} pulse={state.pulse} />
      {label}
    </Badge>
  );
}
