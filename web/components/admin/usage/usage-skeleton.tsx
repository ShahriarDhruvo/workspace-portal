import { Card, CardAction, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Admin > Usage while it loads, in the shape of its cards (same frames, headers and heights), so nothing moves when
// the data arrives: the page's loading.tsx shows all of it, the live view its live part until the first frame.

/** The whole page: heading, the live cards, the energy card. */
export function UsageSkeleton() {
  return (
    <>
      <div className="flex items-end justify-between gap-4">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-5 w-14 rounded-4xl" />
      </div>
      <LiveSkeleton />
      <EnergySkeleton />
    </>
  );
}

/** The LLM sessions, both servers and the workspaces. */
export function LiveSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading the live view">
      <Card className="gap-0 py-0">
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
      <div className="grid gap-4 xl:grid-cols-2">
        <ServerSkeleton />
        <ServerSkeleton />
      </div>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-4 py-3">
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <Rows count={2} />
      </Card>
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

function EnergySkeleton() {
  return (
    <Card className="gap-0 py-0" aria-busy="true" aria-label="Loading energy">
      <CardHeader className="border-b px-4 py-3">
        <Skeleton className="h-8 w-24" />
        <CardAction className="flex gap-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-36" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-[76px] rounded-lg" />
          <Skeleton className="h-[76px] rounded-lg" />
        </div>
        <Skeleton className="h-40" />
      </CardContent>
      <Rows count={5} />
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
