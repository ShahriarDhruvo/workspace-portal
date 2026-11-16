"use client";

import type { AgentKind } from "@portal/db";
import { StatusDot } from "@/components/common/status-dot";
import { PageHeading } from "@/components/layout/page-heading";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LlmCard } from "./llm-card";
import { ServerCard } from "./server-card";
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
 * The admin's Overview, live while the tab is visible: the LLM sessions first (the page's focal point), then both
 * servers, then the running workspaces. Times are measured on the gateway's clock (the frame's `t`).
 */
export function OverviewLive({ agentNames }: { agentNames: Readonly<Record<AgentKind, string>> }) {
  const { status, frame, history, error } = useLiveFeed();
  const badge = STATUS[status];
  return (
    <>
      <PageHeading
        title="Overview"
        actions={
          <Badge variant="outline" className="gap-1.5" aria-live="polite">
            <StatusDot tone={badge.tone} pulse={badge.pulse} />
            {badge.label}
          </Badge>
        }
      >
        The LLM server, the portal server and the workspaces, updated twice a second.
      </PageHeading>
      {status === "retrying" && error ? <ServiceIssue message={error}>Reconnecting by itself.</ServiceIssue> : null}
      {frame ? (
        <>
          <LlmCard llm={frame.llm} tokens={history.tokens} now={frame.t} />
          <div className="grid gap-4 xl:grid-cols-2">
            <ServerCard host={frame.hosts.llm} history={history.llm} now={frame.t} />
            <ServerCard host={frame.hosts.portal} history={history.portal} now={frame.t} />
          </div>
          <WorkspacesCard workspaces={frame.workspaces} now={frame.t} agentNames={agentNames} />
        </>
      ) : (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the live view">
          <Skeleton className="h-96 rounded-xl" />
          <div className="grid gap-4 xl:grid-cols-2">
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-72 rounded-xl" />
          </div>
        </div>
      )}
    </>
  );
}
