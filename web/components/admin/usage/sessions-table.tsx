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
import { Badge } from "@/components/ui/badge";
import { GlobeIcon, LockIcon } from "@/components/ui/icons";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const PAGE_SIZES = [SESSION_PAGE_SIZE];
const COLUMNS = 9;
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
 * the LLM server's energy with its average draw, and what that cost. Two lines a row (the quiet one says when and
 * how long), so it fits the narrow card of a wide desktop. The running ones come first and say what the LLM is
 * doing for them now (from the live frame). The page is read again when the card appears, whenever the frame
 * says the sessions changed (about every 2 s while the LLM works: energy shares and finished requests; a quarter
 * second's wait folds a burst into one read), and on paging; eight rows a page.
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
    <DataTable
      variant="flush"
      footer={
        <DataTablePagination
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
          <DataTableHead>Session</DataTableHead>
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
          <DataTableHead align="right" title="Its share of the LLM server's energy, and the average draw">
            Energy
          </DataTableHead>
          <DataTableHead align="right">Cost</DataTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.rows.length === 0 ? (
          <DataTableEmpty colSpan={COLUMNS}>No sessions yet.</DataTableEmpty>
        ) : (
          data.rows.map((row) => (
            <TableRow key={row.id} className="[&>td]:align-top">
              <TableCell>
                <span className="flex items-center gap-2">
                  <KindIcon kind={row.kind} />
                  <span className="max-w-36 truncate 3xl:max-w-24" title={row.userName}>
                    {row.userName}
                  </span>
                </span>
                <Secondary className="gap-1.5">
                  {row.endedAt === null ? (
                    <>
                      <LiveStatus userId={row.userId} llm={llm} />
                      {formatDuration((now - row.startedAt) / 1000)}
                    </>
                  ) : (
                    <>
                      <LocalTime at={row.startedAt} relative />
                      <span aria-hidden="true">·</span>
                      {formatDuration((row.endedAt - row.startedAt) / 1000)}
                    </>
                  )}
                </Secondary>
              </TableCell>
              <TableCell className={number}>
                {formatCount(row.requests)}
                {row.failed > 0 ? <Secondary className="justify-end text-destructive">{formatCount(row.failed)} failed</Secondary> : null}
              </TableCell>
              <TableCell className={number}>{formatNumber(row.readTps)}</TableCell>
              <TableCell className={number}>{formatNumber(row.writeTps)}</TableCell>
              <TableCell className={number} title={`${row.tokensIn.toLocaleString("en")} tokens, ${row.cachedTokens.toLocaleString("en")} from the cache`}>
                {formatCount(row.tokensIn)}
              </TableCell>
              <TableCell className={number}>{formatCount(row.tokensOut)}</TableCell>
              <TableCell className={number}>{row.requests > 0 ? formatElapsed(row.llmMs) : "—"}</TableCell>
              <TableCell className={number}>
                {formatWh(row.energyWh)}
                {row.watts !== null ? <Secondary className="justify-end">{formatWatts(row.watts)}</Secondary> : null}
              </TableCell>
              <TableCell className={number}>
                <Cost row={row} currency={data.currency} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </DataTable>
  );
}

/** A cell's second, quieter line: when and how long, the failed requests, the average draw. */
function Secondary({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("mt-0.5 flex h-5 items-center text-12 text-muted-foreground tabular-nums", className)}>{children}</span>;
}

function KindIcon({ kind }: { kind: SessionRow["kind"] }) {
  const Icon = kind === "online" ? GlobeIcon : LockIcon;
  return (
    <span className="inline-flex shrink-0 text-muted-foreground" title={KIND_NAMES[kind]}>
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{KIND_NAMES[kind]}</span>
    </span>
  );
}

/** What the LLM is doing for a running session now: its furthest request's phase, waiting, or nothing. */
function LiveStatus({ userId, llm }: { userId: number; llm: LlmLive }): ReactNode {
  const own = llm.sessions.filter((session) => session.userId === userId);
  if (own.some((session) => session.phase === "writing")) return <Badge variant="success">Writing</Badge>;
  const reading = own.find((session) => session.phase === "reading");
  if (reading) {
    const toRead = Math.max(0, (reading.promptTokens ?? 0) - (reading.cachedTokens ?? 0));
    const done = toRead > 0 && reading.processedTokens !== null ? ` ${Math.min(100, Math.round((reading.processedTokens / toRead) * 100))}%` : "";
    return <Badge variant="info">Reading{done}</Badge>;
  }
  if (own.length > 0) return <Badge variant="secondary">Preparing</Badge>;
  const waiting = llm.waiting.find((row) => row.userId === userId);
  if (waiting) {
    return (
      <Badge variant="warning" title={waiting.stage === "portal" ? "In the portal's queue: all sessions are busy" : "Sent to the engine, not started yet"}>
        Waiting
      </Badge>
    );
  }
  return <Badge variant="outline">Running</Badge>;
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
