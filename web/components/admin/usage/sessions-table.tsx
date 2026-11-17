"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { formatCount, formatDuration } from "@/lib/format";
import { formatCost, formatElapsed, formatNumber, formatWatts, formatWh } from "@/lib/live-format";
import type { LlmLive } from "@/lib/live-types";
import { SESSION_PAGE_SIZE, type SessionPage, type SessionRow } from "@/lib/session-types";
import { KIND_NAMES } from "@/lib/workspace-kind";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination } from "@/components/common/data-table";
import { LocalTime } from "@/components/local-time";
import { GlobeIcon, LockIcon } from "@/components/ui/icons";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { SESSIONS_TABLE_HEIGHT } from "./usage-skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const PAGE_SIZES = [SESSION_PAGE_SIZE];
const COLUMNS = 10;
const number = "text-right tabular-nums";

interface SessionsTableProps {
  initial: SessionPage;
  /** The live frame's sessionsVersion: a change reads the page again. */
  version: number;
  llm: LlmLive;
  /** The frame's time, for the running sessions' length. */
  now: number;
}

/**
 * The LLM sessions card's table: each run of a user's workspace, from Start to its stop, and what its LLM requests
 * added up to: Read and Write averaged over the engine's own time, tokens, time on the LLM server, its share of
 * the LLM server's energy as its average draw (the watt-hours on hover), and what that cost. One line a row, the
 * lesser facts in a quieter font. The running ones come first and say what the LLM is doing for them now (from
 * the live frame). The page is read again when the card appears, whenever the frame
 * says the sessions changed (about every 2 s while the LLM works: energy shares and finished requests; a quarter
 * second's wait folds a burst into one read), and on paging; six rows a page.
 */
export function SessionsTable({ initial, version, llm, now }: SessionsTableProps) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [page, setPage] = useState(initial.page);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await fetchJson<SessionPage>(`/api/admin/llm-sessions?page=${page}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // On a failure the rows stay as they were: the live view says when the portal can't be reached.
      if (result.ok) setData(result.data);
      else if (needsReauth(result)) router.refresh();
      setPending(false);
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [page, version, router]);

  return (
    // A full page's height whatever it shows, the pager at the bottom: nothing moves as sessions come and go.
    <div className="flex flex-col" style={{ minHeight: SESSIONS_TABLE_HEIGHT }}>
      <DataTable
        variant="flush"
        className="flex flex-1 flex-col"
        footer={
          <DataTablePagination
            className="mt-auto"
            page={data.page}
            pageSize={SESSION_PAGE_SIZE}
            pageSizes={PAGE_SIZES}
            total={data.total}
            onPageChange={(next) => {
              setPage(next);
              setPending(true);
            }}
            pending={pending}
            label="Sessions pages"
          />
        }
      >
        <TableHeader>
          <TableRow>
            <DataTableHead>User</DataTableHead>
            <DataTableHead title="When it started, or what the LLM is doing for it now; then how long it ran">Started</DataTableHead>
            <DataTableHead align="right" title="Requests to the LLM">
              Reqs
            </DataTableHead>
            <DataTableHead align="right" title="Prompt tokens read per second of the engine's time">
              Read t/s
            </DataTableHead>
            <DataTableHead align="right" title="Answer tokens written per second of the engine's time">
              Write t/s
            </DataTableHead>
            <DataTableHead align="right" title="Tokens in: prompts, cached ones included">
              In
            </DataTableHead>
            <DataTableHead align="right" title="Tokens out: answers">
              Out
            </DataTableHead>
            <DataTableHead align="right" title="Time its requests took on the LLM server">
              LLM time
            </DataTableHead>
            <DataTableHead align="right" title="The average draw of its share of the LLM server's energy">
              Power
            </DataTableHead>
            <DataTableHead align="right">Cost</DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.length === 0 ? (
            <DataTableEmpty colSpan={COLUMNS}>No sessions yet.</DataTableEmpty>
          ) : (
            data.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <KindIcon kind={row.kind} />
                    <span className="max-w-36 truncate 3xl:max-w-28" title={row.userName}>
                      {row.userName}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-baseline">
                    {row.endedAt === null ? <LiveStatus userId={row.userId} llm={llm} /> : <LocalTime at={row.startedAt} relative />}
                    <Quiet>{formatDuration(((row.endedAt ?? now) - row.startedAt) / 1000)}</Quiet>
                  </span>
                </TableCell>
                <TableCell className={number}>
                  {formatCount(row.requests)}
                  {row.failed > 0 ? <Quiet className="text-destructive">{formatCount(row.failed)} failed</Quiet> : null}
                </TableCell>
                <TableCell className={number}>{formatNumber(row.readTps)}</TableCell>
                <TableCell className={number}>{formatNumber(row.writeTps)}</TableCell>
                <TableCell className={number} title={`${row.tokensIn.toLocaleString("en")} tokens, ${row.cachedTokens.toLocaleString("en")} from the cache`}>
                  {formatCount(row.tokensIn)}
                </TableCell>
                <TableCell className={number}>{formatCount(row.tokensOut)}</TableCell>
                <TableCell className={number}>{row.requests > 0 ? formatElapsed(row.llmMs) : "—"}</TableCell>
                <TableCell className={number} title={row.energyWh !== null ? `${formatWh(row.energyWh)} in all` : undefined}>
                  {formatWatts(row.watts)}
                </TableCell>
                <TableCell className={number}>
                  <Cost row={row} currency={data.currency} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </DataTable>
    </div>
  );
}

/** A quieter fact after a cell's value: how long, the failed requests. */
function Quiet({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("ml-1.5 text-12 text-muted-foreground", className)}>{children}</span>;
}

function KindIcon({ kind }: { kind: SessionRow["kind"] }) {
  const Icon = kind === "online" ? GlobeIcon : LockIcon;
  return (
    <span className="inline-flex h-5 shrink-0 items-center text-muted-foreground" title={KIND_NAMES[kind]}>
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{KIND_NAMES[kind]}</span>
    </span>
  );
}

const STATUS_DOTS = { writing: "bg-success", reading: "bg-info", preparing: "bg-info", waiting: "bg-warning", idle: "bg-muted-foreground/50" } as const;
const STATUS_NAMES = { writing: "Writing", reading: "Reading", preparing: "Preparing", waiting: "Waiting", idle: "Running" } as const;
type LiveState = keyof typeof STATUS_DOTS;

/** What the LLM is doing for a running session now: its furthest request's phase, waiting, or nothing. */
function liveState(userId: number, llm: LlmLive): { state: LiveState; title?: string } {
  const phases = new Set(llm.sessions.filter((session) => session.userId === userId).map((session) => session.phase));
  for (const phase of ["writing", "reading", "preparing"] as const) if (phases.has(phase)) return { state: phase };
  const waiting = llm.waiting.find((row) => row.userId === userId);
  if (waiting) return { state: "waiting", title: waiting.stage === "portal" ? "In the portal's queue: all sessions are busy" : "Sent to the engine, not started yet" };
  return { state: "idle" };
}

/** Its state: a dot in its colour (activity colours it, an idle session's is grey) and its name. */
function LiveStatus({ userId, llm }: { userId: number; llm: LlmLive }) {
  const { state, title } = liveState(userId, llm);
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOTS[state])} />
      {STATUS_NAMES[state]}
    </span>
  );
}

/** Its cost; one at a price standing in for a month not yet published is underlined with dots. */
function Cost({ row, currency }: { row: SessionRow; currency: SessionPage["currency"] }) {
  const text = formatCost(row.cost, currency);
  if (!row.costEstimate || row.cost === null) return text;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default rounded-sm underline decoration-dotted underline-offset-4">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>At the latest published price</TooltipContent>
    </Tooltip>
  );
}
