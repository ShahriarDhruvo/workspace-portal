"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatNumber } from "@/lib/live-format";
import type { LlmLive, LlmTotalsPoint } from "@portal/core/wire";
import type { SessionPage } from "@/lib/workspace-sessions";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WarningIcon } from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveChart } from "./live-chart";
import { SessionsTable } from "./sessions-table";

type Total = "readTps" | "writeTps";

interface LlmCardProps {
  llm: LlmLive;
  tokens: readonly LlmTotalsPoint[];
  now: number;
  /** The sessions table's first page, as the page rendered it. */
  sessions: SessionPage;
  sessionsVersion: number;
}

const TOTALS: Record<Total, { label: string; hint: string; color: string }> = {
  readTps: { label: "Read", hint: "Prompt tokens per second, all sessions reading", color: "var(--chart-1)" },
  writeTps: { label: "Write", hint: "Answer tokens per second, all sessions writing", color: "var(--chart-2)" },
};
const TOTAL_KEYS = Object.keys(TOTALS) as Total[];

const ENGINE_BADGES: Record<LlmLive["engine"], ReactNode> = {
  ready: <Badge variant="success">Ready</Badge>,
  loading: <Badge variant="warning">Loading the model</Badge>,
  unloaded: (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" tabIndex={0}>
          Not loaded
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        llama-swap stopped the LLM to make room for an image model, or is starting it again. The next LLM request starts it.
      </TooltipContent>
    </Tooltip>
  ),
  offline: <Badge variant="destructive">Engine offline</Badge>,
  unknown: <Badge variant="secondary">Checking</Badge>,
};

/**
 * Usage's focal card: the LLM server's Read and Write rates over the last minute, each on its own scale (reading
 * runs about ten times faster than writing).
 */
export function LlmCard({ llm, tokens, now, sessions, sessionsVersion }: LlmCardProps) {
  const busy = llm.sessionsReported && llm.engineSessions !== null ? llm.sessions.length : llm.inFlight;
  const capacity = llm.sessionsReported && llm.engineSessions !== null ? llm.engineSessions : llm.maxConcurrency;
  return (
    <Card className="h-full gap-0 py-0">
      <CardHeader className="flex flex-col items-stretch gap-0 border-b px-0 sm:flex-row">
        <div className="flex flex-1 flex-col justify-center gap-1 px-4 py-3">
          <CardTitle className="flex items-center gap-2">
            <h2 className="text-16">LLM sessions</h2>
            {ENGINE_BADGES[llm.engine]}
          </CardTitle>
          <CardDescription className="tabular-nums">
            {busy} of {capacity} busy · {llm.waiting.length} waiting
          </CardDescription>
        </div>
        <div className="flex">
          {TOTAL_KEYS.map((key) => (
            <div
              key={key}
              title={TOTALS[key].hint}
              className="flex flex-1 flex-col justify-center gap-1 border-t px-4 py-3 even:border-l sm:min-w-40 sm:border-t-0 sm:border-l sm:px-6"
            >
              <SeriesName total={key} />
              <span className="text-24 leading-none font-semibold tabular-nums">
                {formatNumber(llm.totals[key])}
                <span className="ml-1 text-13 font-normal text-muted-foreground">tok/s</span>
              </span>
            </div>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 p-4">
        {llm.paused ? (
          <Alert variant="warning">
            <WarningIcon />
            <AlertTitle>The engine is being updated</AlertTitle>
            <AlertDescription>
              <p>
                New requests wait in the portal&apos;s queue until the update is done. See{" "}
                <Link href="/admin/updates" className="underline underline-offset-3">
                  Updates
                </Link>
                .
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-1 flex-col gap-3">
          {TOTAL_KEYS.map((key, index) => (
            <figure key={key} className="flex flex-1 flex-col gap-1">
              <figcaption>
                <SeriesName total={key} />
              </figcaption>
              <LiveChart
                points={tokens.map((point) => ({ t: point.t, value: point[key] }))}
                label={`${TOTALS[key].label}, tok/s`}
                color={TOTALS[key].color}
                now={now}
                format={formatNumber}
                syncId="llm-totals"
                timeAxis={index === TOTAL_KEYS.length - 1}
                className={cn("h-auto flex-1", index === TOTAL_KEYS.length - 1 ? "min-h-21" : "min-h-15")}
              />
            </figure>
          ))}
        </div>
      </CardContent>
      <SessionsTable initial={sessions} version={sessionsVersion} llm={llm} now={now} />
    </Card>
  );
}

/** A total's colour key and name: the header's figures and the charts' captions. */
function SeriesName({ total }: { total: Total }) {
  return (
    <span className="flex items-center gap-1.5 text-12 text-muted-foreground">
      <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: TOTALS[total].color }} />
      {TOTALS[total].label}
    </span>
  );
}
