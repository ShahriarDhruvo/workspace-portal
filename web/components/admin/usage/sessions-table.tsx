"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { formatCount, formatDuration } from "@/lib/format";
import { formatCost, formatElapsed, formatNumber, formatWatts, formatWh } from "@/lib/live-format";
import { SESSION_PAGE_SIZE } from "@/lib/pagination";
import type { SessionPage, SessionRow } from "@/lib/workspace-sessions";
import { WORKSPACE_KIND_NAMES, type LlmLive } from "@portal/core/wire";
import { Estimate } from "@/components/admin/estimate";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination } from "@/components/common/data-table";
import { LocalTime } from "@/components/local-time";
import { GlobeIcon, LockIcon } from "@/components/ui/icons";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { SESSIONS_TABLE_HEIGHT } from "./usage-skeleton";

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
 * The Sessions card's table: each run of a user's workspace and what its requests to the AI server added up to, the
 * running ones first. The page is read again whenever the live frame says the sessions changed (a quarter second's
 * wait folds a burst into one read) and on paging.
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
        tableProps={{
          // Below a wide screen the speeds and the AI time are under the name; on a narrow one all but the cost is.
          className:
            "max-lg:[&_:is(th,td):is(:nth-child(4),:nth-child(5),:nth-child(8))]:hidden max-md:[&_:is(th,td):not(:first-child,:last-child)]:hidden",
        }}
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
            <DataTableHead title="When it started, or what the AI server is doing for it now; then how long it ran">Started</DataTableHead>
            <DataTableHead align="right" title="Requests to the AI server: text, images and media">
              Reqs
            </DataTableHead>
            <DataTableHead align="right" title="Prompt tokens read per second of the engine's time">
              Avg read t/s
            </DataTableHead>
            <DataTableHead align="right" title="Answer tokens written per second of the engine's time">
              Avg write t/s
            </DataTableHead>
            <DataTableHead align="right" title="Tokens in: prompts, cached ones included">
              In
            </DataTableHead>
            <DataTableHead align="right" title="Tokens out: answers">
              Out
            </DataTableHead>
            <DataTableHead align="right" title="Time its requests took on the AI server">
              AI time
            </DataTableHead>
            <DataTableHead align="right" title="Its share of the AI server's measured energy while its requests ran">
              Energy
            </DataTableHead>
            <DataTableHead align="right">Cost</DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.length === 0 ? (
            <DataTableEmpty colSpan={COLUMNS}>No sessions yet.</DataTableEmpty>
          ) : (
            data.rows.map((row) => {
              const started = (
                <>
                  {row.endedAt === null ? <LiveStatus userId={row.userId} llm={llm} /> : <LocalTime at={row.startedAt} relative />}
                  <Quiet>{formatDuration(((row.endedAt ?? now) - row.startedAt) / 1000)}</Quiet>
                </>
              );
              const requests = (
                <>
                  {formatCount(row.requests)}
                  {row.failed > 0 ? <Quiet className="text-destructive">{formatCount(row.failed)} failed</Quiet> : null}
                </>
              );
              const aiTime = row.requests > 0 ? formatElapsed(row.llmMs) : "—";
              const energy = row.energyWh === null ? "—" : formatWh(row.energyWh);
              // What is under the name where its column is folded: the last three on a medium screen, all on a narrow one.
              const folded: Array<[label: string, value: ReactNode, narrow: boolean]> = [
                ["Requests", requests, true],
                ["Tokens in", formatCount(row.tokensIn), true],
                ["Tokens out", formatCount(row.tokensOut), true],
                ["Energy", energy, true],
                ["Avg read t/s", formatNumber(row.readTps), false],
                ["Avg write t/s", formatNumber(row.writeTps), false],
                ["AI time", aiTime, false],
              ];
              return (
                <TableRow key={row.id}>
                  <TableCell className="max-lg:align-top max-lg:whitespace-normal">
                    <span className="flex items-center gap-2">
                      <KindIcon kind={row.kind} />
                      <span className="max-md:wrap-anywhere md:max-w-36 md:truncate 3xl:max-w-28" title={row.userName}>
                        {row.userName}
                      </span>
                    </span>
                    <div className="mt-1 md:hidden">{started}</div>
                    <dl className="mt-1 flex flex-wrap gap-x-3 text-12 tabular-nums lg:hidden">
                      {folded.map(([label, value, narrow]) => (
                        <div key={label} className={cn("flex gap-1 whitespace-nowrap", narrow && "md:hidden")}>
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </TableCell>
                  <TableCell className="max-lg:align-top">{started}</TableCell>
                  <TableCell className={cn(number, "max-lg:align-top")}>{requests}</TableCell>
                  <TableCell className={number}>{formatNumber(row.readTps)}</TableCell>
                  <TableCell className={number}>{formatNumber(row.writeTps)}</TableCell>
                  <TableCell
                    className={cn(number, "max-lg:align-top")}
                    title={`${row.tokensIn.toLocaleString("en")} tokens, ${row.cachedTokens.toLocaleString("en")} from the cache`}
                  >
                    {formatCount(row.tokensIn)}
                  </TableCell>
                  <TableCell className={cn(number, "max-lg:align-top")}>{formatCount(row.tokensOut)}</TableCell>
                  <TableCell className={number}>{aiTime}</TableCell>
                  <TableCell
                    className={cn(number, "max-lg:align-top")}
                    title={row.watts !== null ? `${formatWatts(row.watts)} on average while its requests ran` : undefined}
                  >
                    {energy}
                  </TableCell>
                  <TableCell className={cn(number, "max-lg:align-top")}>
                    <Cost row={row} currency={data.currency} />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </DataTable>
      {/* A phone opens no tooltip: what an underlined cost's tooltip says is written out. */}
      {data.rows.some((row) => row.costEstimate && row.cost !== null) ? (
        <p className="px-4 pb-3 text-13 text-muted-foreground md:hidden">An underlined cost is at the latest published price.</p>
      ) : null}
    </div>
  );
}

/** A quieter fact after a cell's value, in the same size on the same baseline: how long, the failed requests. */
function Quiet({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("ml-2 text-muted-foreground", className)}>{children}</span>;
}

function KindIcon({ kind }: { kind: SessionRow["kind"] }) {
  const Icon = kind === "online" ? GlobeIcon : LockIcon;
  return (
    <span className="inline-flex h-5 shrink-0 items-center text-muted-foreground" title={WORKSPACE_KIND_NAMES[kind]}>
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{WORKSPACE_KIND_NAMES[kind]}</span>
    </span>
  );
}

const STATUS_DOTS = {
  writing: "bg-success",
  reading: "bg-info",
  preparing: "bg-info",
  image: "bg-info",
  video: "bg-info",
  music: "bg-info",
  speech: "bg-info",
  transcription: "bg-info",
  waiting: "bg-warning",
  idle: "bg-muted-foreground/50",
} as const;
const STATUS_NAMES = {
  writing: "Writing",
  reading: "Reading",
  preparing: "Preparing",
  image: "Making an image",
  video: "Making a video",
  music: "Making music",
  speech: "Making speech",
  transcription: "Transcribing",
  waiting: "Waiting",
  idle: "Running",
} as const;
const WAITING_TITLES = {
  portal: "In the portal's queue: all sessions are busy, another model's requests are made first, or an update of the AI server is running",
  engine: "Sent to the engine, not started yet",
  swap: "Sent to the AI server: llama-swap starts the model it needs once the other model's requests are done",
  video: "In the portal's queue: a video is being made, and nothing else runs until it is downloaded",
} as const;
type LiveState = keyof typeof STATUS_DOTS;

/** What the AI server is doing for a running session now: its furthest request's phase, waiting, or nothing. */
function liveState(userId: number, llm: LlmLive): { state: LiveState; title?: string } {
  const own = llm.sessions.filter((session) => session.userId === userId);
  for (const phase of ["writing", "reading", "preparing"] as const) if (own.some((session) => session.phase === phase)) return { state: phase };
  const other = own.find((session) => session.phase !== "writing" && session.phase !== "reading" && session.phase !== "preparing");
  if (other) return { state: other.phase, title: other.model ?? undefined };
  const waiting = llm.waiting.find((row) => row.userId === userId);
  if (waiting) return { state: "waiting", title: WAITING_TITLES[waiting.stage] };
  return { state: "idle" };
}

/** Its state: a dot in its colour (activity colours it, an idle session's is grey) and its name. */
function LiveStatus({ userId, llm }: { userId: number; llm: LlmLive }) {
  const { state, title } = liveState(userId, llm);
  return (
    <>
      <span title={title}>
        <span aria-hidden="true" className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", STATUS_DOTS[state])} />
        {STATUS_NAMES[state]}
      </span>
      {/* Where the columns are folded under the name, what the tooltip says is written out: a phone opens none. */}
      {title ? <span className="block text-12 text-muted-foreground md:hidden">{title}</span> : null}
    </>
  );
}

/** Its cost; one at a price standing in for a month not yet published is underlined with dots. */
function Cost({ row, currency }: { row: SessionRow; currency: SessionPage["currency"] }) {
  const text = formatCost(row.cost, currency);
  if (!row.costEstimate || row.cost === null) return text;
  return <Estimate text={text}>At the latest published price</Estimate>;
}
