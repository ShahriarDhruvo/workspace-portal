"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { formatCount } from "@/lib/format";
import { formatElapsed, formatNumber } from "@/lib/live-format";
import type { LlmFinished, LlmLive, LlmSession, LlmTotalsPoint, LlmWaiting } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WarningIcon } from "@/components/ui/icons";
import { LiveChart } from "./live-chart";

type Total = "readTps" | "writeTps";

const TOTALS: Record<Total, { label: string; hint: string; color: string }> = {
  readTps: { label: "Read", hint: "Prompt tokens per second, all sessions reading", color: "var(--chart-1)" },
  writeTps: { label: "Write", hint: "Answer tokens per second, all sessions writing", color: "var(--chart-2)" },
};

const ENGINE_BADGES: Record<LlmLive["engine"], ReactNode> = {
  ready: <Badge variant="success">Ready</Badge>,
  loading: <Badge variant="warning">Loading the model</Badge>,
  offline: <Badge variant="destructive">Engine offline</Badge>,
  unknown: <Badge variant="secondary">Checking</Badge>,
};

const tps = (value: number) => `${formatNumber(value)}`;
const who = (row: { userId: number | null; userName: string | null }) =>
  row.userName ?? (row.userId === null ? "Outside the portal" : `User #${row.userId}`);

/**
 * The Overview's focal card: the LLM server's total Read and Write rates (the selected one charted over the last
 * minute), then its sessions: running (one row per engine session, with its own rates), waiting, and the last
 * finished requests with the engine's own timings.
 */
export function LlmCard({ llm, tokens, now }: { llm: LlmLive; tokens: readonly LlmTotalsPoint[]; now: number }) {
  const [shown, setShown] = useState<Total>("readTps");
  const points = tokens.map((point) => ({ t: point.t, value: point[shown] }));
  const busy = llm.sessionsReported && llm.engineSessions !== null ? llm.sessions.length : llm.inFlight;
  const capacity = llm.sessionsReported && llm.engineSessions !== null ? llm.engineSessions : llm.maxConcurrency;

  return (
    <Card className="gap-0 py-0">
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
        {/* shadcn's interactive chart header: each total is a button that picks the charted series. */}
        <div className="flex">
          {(Object.keys(TOTALS) as Total[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={shown === key}
              title={TOTALS[key].hint}
              onClick={() => setShown(key)}
              className="relative flex flex-1 flex-col justify-center gap-1 border-t px-4 py-3 text-left transition-colors even:border-l hover:bg-muted/30 focus-visible:-outline-offset-2 aria-pressed:bg-muted/50 sm:min-w-40 sm:border-t-0 sm:border-l sm:px-6"
            >
              <span className="flex items-center gap-1.5 text-12 text-muted-foreground">
                <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: TOTALS[key].color }} />
                {TOTALS[key].label}
              </span>
              <span className="font-mono text-24 leading-none font-medium tabular-nums">
                {formatNumber(llm.totals[key])}
                <span className="ml-1 font-sans text-12 font-normal text-muted-foreground">tok/s</span>
              </span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 py-4">
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
        <LiveChart
          points={points}
          label={`${TOTALS[shown].label}, tok/s`}
          color={TOTALS[shown].color}
          now={now}
          format={tps}
        />
        <Tabs defaultValue="running" className="gap-3">
          <TabsList variant="line" className="w-full justify-start border-b">
            <TabsTrigger value="running" className="flex-none">
              Running <Count n={llm.sessions.length} />
            </TabsTrigger>
            <TabsTrigger value="waiting" className="flex-none">
              Waiting <Count n={llm.waiting.length} />
            </TabsTrigger>
            <TabsTrigger value="recent" className="flex-none">
              Recent <Count n={llm.recent.length} />
            </TabsTrigger>
          </TabsList>
          <TabsContent value="running">
            <RunningTable llm={llm} now={now} />
          </TabsContent>
          <TabsContent value="waiting">
            <WaitingTable waiting={llm.waiting} now={now} />
          </TabsContent>
          <TabsContent value="recent">
            <RecentTable recent={llm.recent} now={now} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Count({ n }: { n: number }) {
  return <span className="font-mono text-12 text-muted-foreground tabular-nums">{n}</span>;
}

/** Tables in this card sit on its surface and scroll sideways on narrow screens; the page never does. */
function SessionTable({ headings, children, footer }: { headings: Array<{ label: string; numeric?: boolean }>; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
      <Table className="[&_tr>*:first-child]:pl-3 [&_tr>*:last-child]:pr-3">
        <TableHeader>
          <TableRow>
            {headings.map((heading) => (
              <TableHead key={heading.label} scope="col" className={cn("h-9 text-12 text-muted-foreground", heading.numeric && "text-right")}>
                {heading.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
        {footer}
      </Table>
    </div>
  );
}

function Nothing({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Empty className="border py-8">
      <EmptyHeader>
        <EmptyTitle className="text-14">{title}</EmptyTitle>
        {children ? <EmptyDescription>{children}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

const PHASES: Record<LlmSession["phase"], ReactNode> = {
  preparing: <Badge variant="secondary">Preparing</Badge>,
  reading: <Badge variant="info">Reading</Badge>,
  writing: <Badge variant="success">Writing</Badge>,
};

const RUNNING_HEADINGS = [
  { label: "Session" },
  { label: "User" },
  { label: "Phase" },
  { label: "Prompt", numeric: true },
  { label: "Read tok/s", numeric: true },
  { label: "Write tok/s", numeric: true },
  { label: "Tokens out", numeric: true },
  { label: "Time", numeric: true },
];

function RunningTable({ llm, now }: { llm: LlmLive; now: number }) {
  if (llm.sessions.length === 0) {
    return (
      <Nothing title="No request is running">
        {llm.engine === "ready" ? "Rows appear here while agents talk to the model." : "The engine isn't ready."}
      </Nothing>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <SessionTable
        headings={RUNNING_HEADINGS}
        footer={
          <TableFooter>
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                Total
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatNumber(llm.totals.readTps)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatNumber(llm.totals.writeTps)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </TableFooter>
        }
      >
        {llm.sessions.map((session, index) => (
          <TableRow key={session.slot ?? `r${index}`}>
            <TableCell className="font-mono text-muted-foreground tabular-nums">{session.slot === null ? index + 1 : `#${session.slot}`}</TableCell>
            <TableCell>
              <span className="block max-w-48 truncate" title={who(session)}>
                {who(session)}
              </span>
            </TableCell>
            <TableCell>{PHASES[session.phase]}</TableCell>
            <TableCell className="text-right tabular-nums">
              <PromptCell session={session} />
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatNumber(session.readTps)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatNumber(session.writeTps)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatCount(session.generatedTokens)}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{formatElapsed(now - session.startedAt)}</TableCell>
          </TableRow>
        ))}
      </SessionTable>
      <p className="text-12 text-muted-foreground">
        {llm.sessionsReported
          ? "Read: prompt tokens processed since the request reached the engine. Write: answer tokens over the last 3 s."
          : "This engine doesn't report its sessions, so Read can't be measured; Write is counted from the answer stream."}
      </p>
    </div>
  );
}

/** "48K · 62% cached", and while reading how far it has got. */
function PromptCell({ session }: { session: LlmSession }) {
  if (session.promptTokens === null) return <span className="text-muted-foreground">—</span>;
  const cached = session.cachedTokens ?? 0;
  const toRead = Math.max(0, session.promptTokens - cached);
  const done = session.processedTokens ?? 0;
  return (
    <span className="inline-flex items-baseline gap-1.5" title={`${session.promptTokens.toLocaleString("en")} tokens, ${cached.toLocaleString("en")} from the cache`}>
      <span className="font-mono">{formatCount(session.promptTokens)}</span>
      <span className="text-12 text-muted-foreground">
        {session.phase === "reading" && toRead > 0
          ? `${Math.min(100, Math.round((done / toRead) * 100))}% read`
          : `${session.promptTokens > 0 ? Math.round((cached / session.promptTokens) * 100) : 0}% cached`}
      </span>
    </span>
  );
}

function WaitingTable({ waiting, now }: { waiting: LlmWaiting[]; now: number }) {
  if (waiting.length === 0) return <Nothing title="Nothing is waiting" />;
  return (
    <SessionTable headings={[{ label: "User" }, { label: "Where" }, { label: "Waiting for", numeric: true }]}>
      {waiting.map((row, index) => (
        <TableRow key={`${row.userId}-${row.since}-${index}`}>
          <TableCell>
            <span className="block max-w-48 truncate">{who(row)}</span>
          </TableCell>
          <TableCell className="text-muted-foreground">
            {row.stage === "portal" ? "Portal queue (all sessions busy)" : "Engine (not started yet)"}
          </TableCell>
          <TableCell className="text-right tabular-nums">{formatElapsed(now - row.since)}</TableCell>
        </TableRow>
      ))}
    </SessionTable>
  );
}

const RECENT_HEADINGS = [
  { label: "User" },
  { label: "Finished" },
  { label: "Prompt", numeric: true },
  { label: "Cached", numeric: true },
  { label: "Read tok/s", numeric: true },
  { label: "Write tok/s", numeric: true },
  { label: "Tokens out", numeric: true },
  { label: "First token", numeric: true },
  { label: "Took", numeric: true },
  { label: "Result" },
];

function RecentTable({ recent, now }: { recent: LlmFinished[]; now: number }) {
  if (recent.length === 0) return <Nothing title="No finished requests yet" />;
  return (
    <div className="flex flex-col gap-2">
      <SessionTable headings={RECENT_HEADINGS}>
        {recent.map((row, index) => (
          <TableRow key={`${row.finishedAt}-${index}`}>
            <TableCell>
              <span className="block max-w-48 truncate">{who(row)}</span>
            </TableCell>
            <TableCell className="tabular-nums text-muted-foreground">
              {now - row.finishedAt < 1000 ? "just now" : `${formatElapsed(now - row.finishedAt)} ago`}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{row.promptTokens === null ? "—" : formatCount(row.promptTokens)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{row.cachedTokens === null ? "—" : formatCount(row.cachedTokens)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.readTps)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.writeTps)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{row.generatedTokens === null ? "—" : formatCount(row.generatedTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatElapsed(row.ttftMs)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatElapsed(row.durationMs)}</TableCell>
            <TableCell>{row.ok ? <Badge variant="success">Done</Badge> : <Badge variant="destructive">Failed</Badge>}</TableCell>
          </TableRow>
        ))}
      </SessionTable>
      <p className="text-12 text-muted-foreground">
        The engine&apos;s own timings: Prompt counts the tokens it read (Cached ones it took from its cache).
      </p>
    </div>
  );
}
