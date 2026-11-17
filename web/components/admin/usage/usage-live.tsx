"use client";

import type { LiveHistory } from "@/lib/live-format";
import type { LiveFrame } from "@/lib/live-types";
import { PageHeading } from "@/components/layout/page-heading";
import { LlmCard } from "./llm-card";
import { ServerCard } from "./server-card";
import { LiveSkeleton, USAGE_GRID } from "./usage-skeleton";
import { useLiveFeed } from "./use-live-feed";
import { ServiceIssue } from "../service-issue";

/**
 * Admin > Usage, live while the tab is visible: the LLM sessions (the page's focal point) and both servers (the
 * same metrics at the same height, to compare); times are measured on the gateway's clock (the frame's `t`).
 * Below 3xl the sessions span the width over the two servers; on a wide desktop the three sit side by side. The
 * stream says nothing while it flows; a lost connection is shown until it is back.
 */
export function UsageLive() {
  const { status, frame, history, error } = useLiveFeed();
  return (
    <>
      <PageHeading title="Usage" />
      {status === "retrying" ? <ServiceIssue message={error ?? "The live view lost its connection."}>Reconnecting by itself.</ServiceIssue> : null}
      {frame ? <LiveCards frame={frame} history={history} /> : <LiveSkeleton />}
    </>
  );
}

function LiveCards({ frame, history }: { frame: LiveFrame; history: LiveHistory }) {
  return (
    // items-start: one card's open Details doesn't stretch the others.
    <div className={USAGE_GRID}>
      <div className="min-w-0 xl:col-span-2 3xl:col-span-1">
        <LlmCard llm={frame.llm} tokens={history.tokens} now={frame.t} />
      </div>
      <ServerCard host={frame.hosts.llm} history={history.llm} now={frame.t} />
      <ServerCard host={frame.hosts.portal} history={history.portal} now={frame.t} />
    </div>
  );
}
