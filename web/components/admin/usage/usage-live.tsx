"use client";

import type { AgentKind } from "@portal/db";
import type { EnergyMonth } from "@/lib/energy";
import type { LiveFrame } from "@/lib/live-types";
import { StatusDot } from "@/components/common/status-dot";
import { PageHeading } from "@/components/layout/page-heading";
import { Badge } from "@/components/ui/badge";
import { EnergyCard } from "./energy-card";
import { LlmCard } from "./llm-card";
import { ServerCard } from "./server-card";
import { LiveSkeleton } from "./usage-skeleton";
import { useLiveFeed, type LiveStatus } from "./use-live-feed";
import { WorkspacesCard } from "./workspaces-card";
import { ServiceIssue } from "../service-issue";

const STATUS: Record<LiveStatus, { label: string; tone: "success" | "idle" | "warning"; pulse: boolean }> = {
  live: { label: "Live", tone: "success", pulse: true },
  connecting: { label: "Connecting", tone: "idle", pulse: false },
  paused: { label: "Paused", tone: "idle", pulse: false },
  retrying: { label: "Reconnecting", tone: "warning", pulse: false },
};

/**
 * Admin > Usage. Live while the tab is visible: the LLM sessions first (the page's focal point), then both servers
 * side by side (the same metrics at the same height, to compare), then the running workspaces; times are measured
 * on the gateway's clock (the frame's `t`). Last, the energy both servers used and its cost, which changes slowly
 * and keeps its own once-a-minute refresh (`energy`: the current month, rendered by the page).
 */
export function UsageLive({ agentNames, energy }: { agentNames: Readonly<Record<AgentKind, string>>; energy: EnergyMonth }) {
  const { status, frame, history, error } = useLiveFeed();
  const badge = STATUS[status];
  return (
    <>
      <PageHeading
        title="Usage"
        actions={
          <Badge variant="outline" className="gap-1.5" aria-live="polite">
            <StatusDot tone={badge.tone} pulse={badge.pulse} />
            {badge.label}
          </Badge>
        }
      />
      {status === "retrying" && error ? <ServiceIssue message={error}>Reconnecting by itself.</ServiceIssue> : null}
      {frame ? (
        <>
          <LlmCard llm={frame.llm} tokens={history.tokens} now={frame.t} />
          {/* items-start: one card's open Details doesn't stretch the other. */}
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <ServerCard host={frame.hosts.llm} history={history.llm} now={frame.t} />
            <ServerCard host={frame.hosts.portal} history={history.portal} now={frame.t} />
          </div>
          <WorkspacesCard workspaces={frame.workspaces} now={frame.t} agentNames={agentNames} />
        </>
      ) : (
        <LiveSkeleton />
      )}
      <EnergyCard initial={energy} sensors={sensorNames(frame)} />
    </>
  );
}

/** What each server's power reading is ("LLM server: APU socket power"), for the energy card's hint. */
function sensorNames(frame: LiveFrame | null): string {
  if (!frame) return "";
  const named = [
    ["LLM server", frame.hosts.llm.info?.power?.label],
    ["Portal server", frame.hosts.portal.info?.power?.label],
  ] as const;
  return named
    .filter(([, label]) => label)
    .map(([server, label]) => `${server}: ${label}`)
    .join("; ");
}
