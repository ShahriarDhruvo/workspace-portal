"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatNumber } from "@/lib/live-format";
import type { LlmImages, LlmLive, LlmTotalsPoint } from "@portal/core/wire";
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
  readTps: { label: "Read", hint: "Prompt tokens per second, all sessions reading. None while the LLM is not loaded", color: "var(--chart-1)" },
  writeTps: { label: "Write", hint: "Answer tokens per second, all sessions writing. None while the LLM is not loaded", color: "var(--chart-2)" },
};
// The header's figures: under the title in a narrow card, beside it in a wide one. Top-aligned, so that labels and
// figures line up beside the Images tile's extra line.
const HEADER_ROW = "flex flex-col items-stretch gap-0 border-b px-0 @3xl/llm:flex-row";
const HEADER_TILE = "flex flex-1 flex-col gap-1 border-t px-4 py-3 @3xl/llm:min-w-40 @3xl/llm:border-t-0 @3xl/llm:border-l @3xl/llm:px-6";
const TOTAL_KEYS = Object.keys(TOTALS) as Total[];

/** The engine's state, or "Making images" while it is stopped for image models at work. */
function EngineBadge({ llm }: { llm: LlmLive }) {
  const models = [...new Set(llm.sessions.filter((session) => session.phase === "image").map((session) => session.imageModel ?? "an image model"))];
  if (llm.engine !== "unloaded" || models.length === 0) return ENGINE_BADGES[llm.engine];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="info" tabIndex={0}>
          Making images
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        llama-swap stopped the LLM for {models.join(" and ")}. LLM requests wait until the images are done, then the LLM starts again.
      </TooltipContent>
    </Tooltip>
  );
}

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
  const busy = llm.sessions.length;
  const capacity = llm.sessionsReported && llm.engineSessions !== null ? llm.engineSessions : llm.maxConcurrency;
  return (
    <Card className="@container/llm h-full gap-0 py-0">
      <CardHeader className={HEADER_ROW}>
        <div className="flex flex-1 flex-col justify-center gap-1 px-4 py-3">
          <CardTitle className="flex items-center gap-2">
            <h2 className="text-16">LLM sessions</h2>
            <EngineBadge llm={llm} />
          </CardTitle>
          <CardDescription className="tabular-nums">
            {busy} of {capacity} busy · {llm.waiting.length} waiting
          </CardDescription>
        </div>
        <div className="flex flex-wrap">
          {TOTAL_KEYS.map((key) => (
            <div key={key} title={TOTALS[key].hint} className={cn(HEADER_TILE, key === "writeTps" && "border-l")}>
              <SeriesName total={key} />
              <span className="text-24 leading-none font-semibold tabular-nums">
                {formatNumber(llm.totals[key])}
                {llm.totals[key] !== null ? <span className="ml-1 text-13 font-normal text-muted-foreground">tok/s</span> : null}
              </span>
            </div>
          ))}
          {llm.images ? <ImagesTile images={llm.images} /> : null}
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

/**
 * The image models' work: images being made, and the seconds an image takes. Their server reports no progress, so
 * these come from the portal's own record of the requests.
 */
function ImagesTile({ images }: { images: LlmImages }) {
  const { pace } = images;
  const hint = pace
    ? `Image requests being made now. ${formatNumber(pace.secondsPerImage)} s per image: the median of the last five on ${pace.model ?? "an image model"}, each from when it could start (not the wait behind other requests) to its answer, a model start included when one was needed`
    : "Image requests being made now. Seconds per image show once one has finished";
  return (
    // A row of its own under Read and Write in a phone's narrow card.
    <div title={hint} className={cn(HEADER_TILE, "basis-full @md/llm:basis-auto @md/llm:border-l")}>
      <span className="text-12 text-muted-foreground">Images</span>
      <span className="text-24 leading-none font-semibold whitespace-nowrap tabular-nums">
        {images.making}
        <span className="ml-1 text-13 font-normal text-muted-foreground">in progress</span>
      </span>
      <span className="text-12 whitespace-nowrap text-muted-foreground tabular-nums">{pace ? `${formatNumber(pace.secondsPerImage)} s per image` : "no image yet"}</span>
    </div>
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
