"use client";

import type { LiveHistory } from "@/lib/live-format";
import type { LiveFrame } from "@portal/core/wire";
import type { SessionPage } from "@/lib/workspace-sessions";
import { PageHeading } from "@/components/layout/page-heading";
import { LlmCard } from "./llm-card";
import { ServerCard } from "./server-card";
import { LiveSkeleton, USAGE_GRID } from "./usage-skeleton";
import { useLiveFeed } from "./use-live-feed";
import { ServiceIssue } from "../service-issue";

/**
 * Admin > Usage, live while the tab is visible; times are measured on the gateway's clock (the frame's `t`).
 * `sessions`: the sessions table's first page, read as the page rendered.
 */
export function UsageLive({ sessions }: { sessions: SessionPage }) {
  const { status, frame, history, error } = useLiveFeed();
  return (
    <>
      <PageHeading title="Usage" />
      {status === "retrying" ? <ServiceIssue message={error ?? "The live view lost its connection."}>Reconnecting by itself.</ServiceIssue> : null}
      {frame ? <LiveCards frame={frame} history={history} sessions={sessions} /> : <LiveSkeleton rows={sessions.rows.length} />}
    </>
  );
}

function LiveCards({ frame, history, sessions }: { frame: LiveFrame; history: LiveHistory; sessions: SessionPage }) {
  return (
    <div className={USAGE_GRID}>
      <div className="min-w-0 xl:col-span-2 3xl:col-span-1">
        <LlmCard llm={frame.llm} tokens={history.tokens} now={frame.t} sessions={sessions} sessionsVersion={frame.sessionsVersion} />
      </div>
      <ServerCard host={frame.hosts.llm} history={history.llm} now={frame.t} />
      <ServerCard host={frame.hosts.portal} history={history.portal} now={frame.t} />
    </div>
  );
}
