import { Card, CardAction, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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
        <CardHeader className="border-b px-4 py-3">
          <TitleLines />
          <CardAction className="flex gap-6">
            <Figure />
            <Figure />
          </CardAction>
        </CardHeader>
        <CardContent className="p-4">
          <Skeleton className="h-32" />
        </CardContent>
        <div className="flex h-10 items-center gap-4 border-b px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Rows count={3} />
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
        <TitleLines />
        <CardAction>
          <Figure />
        </CardAction>
      </CardHeader>
      <CardContent className="@container flex flex-col gap-4 p-4">
        <Skeleton className="h-24" />
        <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3">
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="col-span-2 h-28 rounded-lg" />
        </div>
      </CardContent>
      <CardFooter className="h-10 justify-center p-0">
        <Skeleton className="h-4 w-16" />
      </CardFooter>
    </Card>
  );
}

/** A card title over its description. */
function TitleLines() {
  return (
    <div className="flex flex-col gap-2 py-0.5">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-56 max-w-full" />
    </div>
  );
}

/** A header's figure over its label. */
function Figure() {
  return (
    <div className="flex flex-col items-end gap-2">
      <Skeleton className="h-6 w-20" />
      <Skeleton className="h-3 w-14" />
    </div>
  );
}

/** A table's heading row and `count` rows, edge to edge in a card. */
function Rows({ count }: { count: number }) {
  return (
    <div className="flex flex-col">
      <div className="flex h-9 items-center border-b px-4">
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-11 items-center border-b px-4 last:border-b-0">
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}
