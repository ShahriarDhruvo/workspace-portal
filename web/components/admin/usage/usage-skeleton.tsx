import { SESSION_PAGE_SIZE } from "@/lib/session-types";
import { cn } from "@/lib/utils";
import { DataTable, DataTableEmpty, DataTableHead } from "@/components/common/data-table";
import { Card, CardAction, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";

// Admin > Usage while it loads, in the shape of its cards (same frames, headers and heights), so nothing moves when
// the data arrives: the page's loading.tsx shows all of it, the live view its cards until the first frame.

/**
 * The cards' layout (UsageLive and its skeleton): the sessions over the two servers, which sit side by side from
 * xl; on a wide desktop (3xl) all three in a row, the sessions a little wider for their table. Cards in a row are
 * as tall as the tallest: each gives the extra height to its charts.
 */
export const USAGE_GRID = "grid gap-4 xl:grid-cols-2 3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]";

/** The sessions table's height with a full page (its heading row, the rows and the pager), kept whatever it shows. */
export const SESSIONS_TABLE_HEIGHT = 36 + SESSION_PAGE_SIZE * 37 + 53;

/** The whole page: heading and the live cards. */
export function UsageSkeleton() {
  return (
    <>
      <Skeleton className="h-6 w-20" />
      <LiveSkeleton />
    </>
  );
}

/**
 * The LLM sessions and both servers. `rows`: the sessions table's rows on its first page, when known (UsageLive
 * knows, the page's loading.tsx doesn't and guesses a full page).
 */
export function LiveSkeleton({ rows = SESSION_PAGE_SIZE }: { rows?: number }) {
  return (
    <div className={USAGE_GRID} aria-busy="true" aria-label="Loading the live view">
      <Card className="gap-0 py-0 xl:col-span-2 3xl:col-span-1">
        {/* LlmCard's header: title and description, then the Read and Write totals (under them on a phone). */}
        <CardHeader className="flex flex-col items-stretch gap-0 border-b px-0 sm:flex-row">
          <div className="flex flex-1 flex-col justify-center gap-1 px-4 py-3">
            <Skeleton className="my-0.5 h-5 w-40" />
            <Skeleton className="my-0.5 h-4 w-36" />
          </div>
          <div className="flex">
            {[0, 1].map((key) => (
              <div
                key={key}
                className="flex flex-1 flex-col justify-center gap-1 border-t px-4 py-3 even:border-l sm:min-w-40 sm:border-t-0 sm:border-l sm:px-6"
              >
                <Skeleton className="my-0.5 h-3 w-12" />
                <Skeleton className="my-px h-6 w-20" />
              </div>
            ))}
          </div>
        </CardHeader>
        {/* The Read and Write charts, each under its caption; the lower one has the time axis. */}
        <CardContent className="flex flex-1 flex-col gap-3 p-4">
          {["min-h-15", "min-h-21"].map((height) => (
            <div key={height} className="flex flex-1 flex-col gap-1">
              <Skeleton className="my-0.5 h-3 w-12" />
              <Skeleton className={cn("flex-1", height)} />
            </div>
          ))}
        </CardContent>
        <SessionsSkeleton rows={rows} />
      </Card>
      <ServerSkeleton />
      <ServerSkeleton />
    </div>
  );
}

/** SessionsTable: its heading row and rows (built from the same parts) and the pager, or its empty state. */
function SessionsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col" style={{ minHeight: SESSIONS_TABLE_HEIGHT }}>
      <DataTable
        variant="flush"
        className="flex flex-1 flex-col"
        footer={
          rows > 0 ? (
            <div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-8 w-24" />
            </div>
          ) : null
        }
      >
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <DataTableHead>
              <Skeleton className="h-3 w-14" />
            </DataTableHead>
            <DataTableHead colSpan={9}>
              <Skeleton className="ml-auto h-3 w-full max-w-sm" />
            </DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows === 0 ? (
            <DataTableEmpty colSpan={2}>
              <Skeleton className="mx-auto my-0.5 h-4 w-28" />
            </DataTableEmpty>
          ) : (
            Array.from({ length: rows }, (_, row) => (
              <TableRow key={row} className="hover:bg-transparent">
                <TableCell>
                  <Skeleton className="my-0.5 h-4 w-28" />
                </TableCell>
                <TableCell colSpan={9}>
                  <Skeleton className="my-0.5 ml-auto h-4 w-full max-w-sm" />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </DataTable>
    </div>
  );
}

function ServerSkeleton() {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        {/* The title's and the description's lines. */}
        <Skeleton className="my-0.5 h-5 w-40" />
        <Skeleton className="my-0.5 h-4 w-56 max-w-full" />
        <CardAction className="flex flex-col items-end gap-1">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="my-0.5 h-3 w-16" />
        </CardAction>
      </CardHeader>
      <ServerBodySkeleton />
    </Card>
  );
}

/** A server card's metrics: two to a row in a narrow card, three from @lg (the card is a @container). */
export const METRIC_GRID = "grid grid-cols-2 gap-3 @lg:grid-cols-3";

/** The readings under them, and the groups under Details, laid out the same. */
export const DETAIL_GRID = "grid grid-cols-2 gap-x-6 gap-y-4 @lg:grid-cols-3";

/**
 * A server card under its header until its readings arrive (also ServerCard's own, while it waits for the first):
 * the chart, the five metrics, the CPU, GPU and memory readings and the Details footer, each at its real height in
 * a phone's card, a narrow card and from @lg.
 */
export function ServerBodySkeleton({ busyLabel }: { busyLabel?: string }) {
  return (
    <>
      <CardContent className="@container flex flex-1 flex-col gap-4 p-4" aria-busy={busyLabel ? true : undefined} aria-label={busyLabel}>
        <Skeleton className="min-h-24 flex-1" />
        <div className={METRIC_GRID}>
          <Skeleton className="h-[86.4px] rounded-lg @lg:h-[110.4px]" />
          <Skeleton className="h-[86.4px] rounded-lg @lg:h-[110.4px]" />
          <Skeleton className="h-[127px] rounded-lg @[22rem]:h-[111px] @lg:h-[110.4px]" />
          <Skeleton className="h-[127px] rounded-lg @[22rem]:h-[111px] @lg:h-[111px]" />
          <Skeleton className="col-span-2 h-[98.4px] rounded-lg @lg:h-[111px]" />
        </div>
        <div className={cn(DETAIL_GRID, "border-t pt-4")}>
          <Skeleton className="h-[118px]" />
          <Skeleton className="h-[118px]" />
          <Skeleton className="h-[98px] @lg:h-[118px]" />
        </div>
      </CardContent>
      <CardFooter className="justify-center p-0">
        <div className="flex h-10 items-center">
          <Skeleton className="h-4 w-16" />
        </div>
      </CardFooter>
    </>
  );
}
