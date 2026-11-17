import { Card, CardAction, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Admin > Usage while it loads, in the shape of its cards (same frames, headers and heights), so nothing moves when
// the data arrives: the page's loading.tsx shows all of it, the live view its cards until the first frame.

/**
 * The cards' layout (UsageLive and its skeleton): the sessions over the two servers, which sit side by side from
 * xl; on a wide desktop (3xl) all three in a row, the sessions a little wider for their table.
 */
export const USAGE_GRID = "grid items-start gap-4 xl:grid-cols-2 3xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]";

/** The whole page: heading and the live cards. */
export function UsageSkeleton() {
  return (
    <>
      <Skeleton className="h-6 w-20" />
      <LiveSkeleton />
    </>
  );
}

/** The LLM sessions and both servers. */
export function LiveSkeleton() {
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
        <CardContent className="p-4">
          <Skeleton className="h-32" />
        </CardContent>
        <div className="flex h-8 items-center gap-4 border-b px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
        {/* The sessions table's heading row over its empty state, the card at rest. */}
        <div className="flex h-9 items-center border-b px-4">
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        <div className="flex h-25 items-center justify-center">
          <Skeleton className="h-4 w-36" />
        </div>
      </Card>
      <ServerSkeleton />
      <ServerSkeleton />
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
 * a narrow card and from @lg. A server with fans has one group more, which the skeleton can't know of.
 */
export function ServerBodySkeleton({ busyLabel }: { busyLabel?: string }) {
  return (
    <>
      <CardContent className="@container flex flex-1 flex-col gap-4 p-4" aria-busy={busyLabel ? true : undefined} aria-label={busyLabel}>
        <Skeleton className="h-24" />
        <div className={METRIC_GRID}>
          <Skeleton className="h-[86px] rounded-lg @lg:h-[110px]" />
          <Skeleton className="h-[86px] rounded-lg @lg:h-[110px]" />
          <Skeleton className="h-[127px] rounded-lg @lg:h-[110px]" />
          <Skeleton className="h-[127px] rounded-lg @lg:h-[111px]" />
          <Skeleton className="col-span-2 h-[98px] rounded-lg @lg:h-[111px]" />
        </div>
        <div className={cn(DETAIL_GRID, "border-t pt-4")}>
          <Skeleton className="h-[138px]" />
          <Skeleton className="h-[138px]" />
          <Skeleton className="h-[98px] @lg:h-[138px]" />
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
