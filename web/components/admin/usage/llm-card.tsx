"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { formatCount } from "@/lib/format";
import { formatElapsed, formatNumber } from "@/lib/live-format";
import type { LlmFinished, LlmLive, LlmSession, LlmTotalsPoint, LlmWaiting } from "@/lib/live-types";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableFooter, TableHeader, TableRow } from "@/components/ui/table";
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

const who = (row: { userId: number | null; userName: string | null }) =>
  row.userName ?? (row.userId === null ? "Outside the portal" : `User #${row.userId}`);

/**
 * Usage's focal card: the LLM server's total Read and Write rates (the selected one charted over the last minute),
 * then its sessions in tabs, each a paged table: running (one row per engine session, with its own rates), waiting,
 * and the last finished requests with the engine's own timings.
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
              <span className="text-24 leading-none font-semibold tabular-nums">
                {formatNumber(llm.totals[key])}
                <span className="ml-1 text-13 font-normal text-muted-foreground">tok/s</span>
              </span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4">
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
        <LiveChart points={points} label={`${TOTALS[shown].label}, tok/s`} color={TOTALS[shown].color} now={now} format={formatNumber} />
      </CardContent>
      <Tabs defaultValue="running" className="gap-0">
        <TabsList variant="line" className="h-auto w-full justify-start gap-4 rounded-none border-b px-4 py-0">
          <SessionTab value="running" label="Running" count={llm.sessions.length} />
          <SessionTab value="waiting" label="Waiting" count={llm.waiting.length} />
          <SessionTab value="recent" label="Recent" count={llm.recent.length} />
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
    </Card>
  );
}

/**
 * A tab with its row count as a badge. Radix focuses a tab from its own mousedown, by script, which browsers take
 * for keyboard focus: the focus box would stay around a clicked tab. A click focuses it here instead, without the
 * box (focusing a tab selects it); the keyboard still gets the box.
 */
function SessionTab({ value, label, count }: { value: string; label: string; count: number }) {
  return (
    <TabsTrigger
      value={value}
      onMouseDown={(event) => {
        if (event.button !== 0 || event.ctrlKey) return;
        event.preventDefault();
        event.currentTarget.focus({ focusVisible: false });
      }}
      className="h-10 flex-none px-0 group-data-horizontal/tabs:after:bottom-[-1px]"
    >
      {label}
      <Badge variant="secondary" className="min-w-5 px-1.5 tabular-nums">
        {count}
      </Badge>
    </TabsTrigger>
  );
}

const PHASES: Record<LlmSession["phase"], ReactNode> = {
  preparing: <Badge variant="secondary">Preparing</Badge>,
  reading: <Badge variant="info">Reading</Badge>,
  writing: <Badge variant="success">Writing</Badge>,
};

const number = "text-right tabular-nums";

function RunningTable({ llm, now }: { llm: LlmLive; now: number }) {
  const { rows, pagination } = usePagination(llm.sessions);
  return (
    <DataTable variant="flush" footer={<DataTablePagination {...pagination} label="Running requests pages" />}>
      <TableHeader>
        <TableRow>
          <DataTableHead>Session</DataTableHead>
          <DataTableHead>User</DataTableHead>
          <DataTableHead>Phase</DataTableHead>
          <DataTableHead align="right">Prompt</DataTableHead>
          <DataTableHead align="right">Read tok/s</DataTableHead>
          <DataTableHead align="right">Write tok/s</DataTableHead>
          <DataTableHead align="right">Tokens out</DataTableHead>
          <DataTableHead align="right">Time</DataTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <DataTableEmpty colSpan={8}>{llm.engine === "ready" ? "No request is running." : "The engine isn't ready."}</DataTableEmpty>
        ) : (
          rows.map((session) => (
            <TableRow key={session.slot ?? `r${llm.sessions.indexOf(session)}`}>
              <TableCell className="text-muted-foreground tabular-nums">
                {session.slot === null ? llm.sessions.indexOf(session) + 1 : `#${session.slot}`}
              </TableCell>
              <TableCell>
                <span className="block max-w-48 truncate" title={who(session)}>
                  {who(session)}
                </span>
              </TableCell>
              <TableCell>{PHASES[session.phase]}</TableCell>
              <TableCell className={number}>
                <PromptCell session={session} />
              </TableCell>
              {/* Only the phase's own speed, as the totals count it: a writing row's earlier read speed is history. */}
              <TableCell className={number}>{formatNumber(session.phase === "reading" ? session.readTps : null)}</TableCell>
              <TableCell className={number}>{formatNumber(session.phase === "writing" ? session.writeTps : null)}</TableCell>
              <TableCell className={number}>{formatCount(session.generatedTokens)}</TableCell>
              <TableCell className={`${number} text-muted-foreground`}>{formatElapsed(now - session.startedAt)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
      {rows.length > 0 ? (
        <TableFooter>
          <TableRow>
            <TableCell colSpan={4} className="text-muted-foreground">
              Total
            </TableCell>
            <TableCell className={number}>{formatNumber(llm.totals.readTps)}</TableCell>
            <TableCell className={number}>{formatNumber(llm.totals.writeTps)}</TableCell>
            <TableCell colSpan={2} />
          </TableRow>
        </TableFooter>
      ) : null}
    </DataTable>
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
      {formatCount(session.promptTokens)}
      <span className="text-12 text-muted-foreground">
        {session.phase === "reading" && toRead > 0
          ? `${Math.min(100, Math.round((done / toRead) * 100))}% read`
          : `${session.promptTokens > 0 ? Math.round((cached / session.promptTokens) * 100) : 0}% cached`}
      </span>
    </span>
  );
}

function WaitingTable({ waiting, now }: { waiting: LlmWaiting[]; now: number }) {
  const { rows, pagination } = usePagination(waiting);
  return (
    <DataTable variant="flush" footer={<DataTablePagination {...pagination} label="Waiting requests pages" />}>
      <TableHeader>
        <TableRow>
          <DataTableHead>User</DataTableHead>
          <DataTableHead>Where</DataTableHead>
          <DataTableHead align="right">Waiting for</DataTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <DataTableEmpty colSpan={3}>Nothing is waiting.</DataTableEmpty>
        ) : (
          rows.map((row) => (
            <TableRow key={`${row.userId}-${row.since}-${row.stage}`}>
              <TableCell>
                <span className="block max-w-48 truncate">{who(row)}</span>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.stage === "portal" ? "Portal queue (all sessions busy)" : "Engine (not started yet)"}
              </TableCell>
              <TableCell className={number}>{formatElapsed(now - row.since)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </DataTable>
  );
}

/** The finished requests, newest first; one that failed says so on its row. */
function RecentTable({ recent, now }: { recent: LlmFinished[]; now: number }) {
  const { rows, pagination } = usePagination(recent);
  const counted = (value: number | null) => (value === null ? "—" : formatCount(value));
  return (
    <DataTable variant="flush" footer={<DataTablePagination {...pagination} label="Recent requests pages" />}>
      <TableHeader>
        <TableRow>
          <DataTableHead>User</DataTableHead>
          <DataTableHead>Finished</DataTableHead>
          <DataTableHead align="right">Prompt</DataTableHead>
          <DataTableHead align="right">Cached</DataTableHead>
          <DataTableHead align="right">Read tok/s</DataTableHead>
          <DataTableHead align="right">Write tok/s</DataTableHead>
          <DataTableHead align="right">Tokens out</DataTableHead>
          <DataTableHead align="right">First token</DataTableHead>
          <DataTableHead align="right">Took</DataTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <DataTableEmpty colSpan={9}>No finished requests yet.</DataTableEmpty>
        ) : (
          rows.map((row) => (
            <TableRow key={`${row.finishedAt}-${row.userId}-${row.durationMs}`}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <span className="max-w-48 truncate">{who(row)}</span>
                  {row.ok ? null : <Badge variant="destructive">Failed</Badge>}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {now - row.finishedAt < 1000 ? "just now" : `${formatElapsed(now - row.finishedAt)} ago`}
              </TableCell>
              <TableCell className={number}>{counted(row.promptTokens)}</TableCell>
              <TableCell className={number}>{counted(row.cachedTokens)}</TableCell>
              <TableCell className={number}>{formatNumber(row.readTps)}</TableCell>
              <TableCell className={number}>{formatNumber(row.writeTps)}</TableCell>
              <TableCell className={number}>{counted(row.generatedTokens)}</TableCell>
              <TableCell className={number}>{formatElapsed(row.ttftMs)}</TableCell>
              <TableCell className={number}>{formatElapsed(row.durationMs)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </DataTable>
  );
}
