"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatNumber } from "@/lib/live-format";
import type { LlmGeneration, LlmLive, LlmTotalsPoint } from "@portal/core/wire";
import { generationTileCopy } from "@/lib/generation-tile";
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
// figures line up beside the generation tile's extra line.
const HEADER_ROW = "flex flex-col items-stretch gap-0 border-b px-0 @3xl/llm:flex-row";
const HEADER_TILE = "flex flex-1 flex-col gap-1 border-t px-4 py-3 @3xl/llm:min-w-40 @3xl/llm:border-t-0 @3xl/llm:border-l @3xl/llm:px-6";
const TOTAL_KEYS = Object.keys(TOTALS) as Total[];

/** What the models other than the LLM are making, by kind, in the order the badge names them. */
const WORK_BADGES = {
  video: { label: "Making a video", wait: "LLM requests wait in the portal's queue until the video is downloaded, then the LLM starts again." },
  music: { label: "Making music", wait: "LLM requests wait until the track is done, then the LLM starts again." },
  speech: { label: "Making speech", wait: "LLM requests wait until the speech is done, then the LLM starts again." },
  transcription: { label: "Transcribing", wait: "LLM requests wait until the transcript is done, then the LLM starts again." },
  image: { label: "Making images", wait: "LLM requests wait until the images are done, then the LLM starts again." },
} as const;
const WORK_KINDS = Object.keys(WORK_BADGES) as (keyof typeof WORK_BADGES)[];

/** The engine's state, or what is being made ("Making images", "Making a video") while the LLM is stopped for it. */
function EngineBadge({ llm }: { llm: LlmLive }) {
  const kind = WORK_KINDS.find((work) => llm.sessions.some((session) => session.phase === work));
  // A video job holds the queue from its start, before llama-swap has stopped the LLM.
  if (kind === undefined || (llm.engine !== "unloaded" && kind !== "video")) return ENGINE_BADGES[llm.engine];
  const models = [...new Set(llm.sessions.filter((session) => session.phase === kind).map((session) => session.model ?? `the ${kind} model`))];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="info" tabIndex={0}>
          {WORK_BADGES[kind].label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        llama-swap stopped the LLM for {models.join(" and ")}. {WORK_BADGES[kind].wait}
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
        llama-swap stopped the LLM to make room for an image or media model, or is starting it again. The next LLM request starts it.
      </TooltipContent>
    </Tooltip>
  ),
  offline: <Badge variant="destructive">Engine offline</Badge>,
  unknown: <Badge variant="secondary">Checking</Badge>,
};

/**
 * Usage's focal card: the AI server's Read and Write rates over the last minute, each on its own scale (reading
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
            <h2 className="text-16">Sessions</h2>
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
          {llm.generation ? <GenerationTile generation={llm.generation} /> : null}
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
 * The image and media models' work, by the kind being made now or else made last: how many are being made (a video's
 * percent done), and how long one takes (generation-tile.ts).
 */
function GenerationTile({ generation }: { generation: LlmGeneration }) {
  const copy = generationTileCopy(generation);
  return (
    // A row of its own under Read and Write in a phone's narrow card.
    <div title={copy.hint} className={cn(HEADER_TILE, "basis-full @md/llm:basis-auto @md/llm:border-l")}>
      <span className="text-12 text-muted-foreground">{copy.label}</span>
      <span className="text-24 leading-none font-semibold whitespace-nowrap tabular-nums">
        {copy.figure}
        <span className="ml-1 text-13 font-normal text-muted-foreground">{copy.suffix}</span>
      </span>
      <span className="text-12 whitespace-nowrap text-muted-foreground tabular-nums">{copy.detail}</span>
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
