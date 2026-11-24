import { PageMain } from "@/components/layout/page-main";
import { Card, CardAction, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Home while it loads, as when stopped. */
export default function HomeLoading() {
  return (
    <PageMain width="sm" className="gap-4">
      <Card aria-busy="true" aria-label="Loading your workspace">
        <CardHeader>
          <Skeleton className="h-6 w-36" />
          <Skeleton className="col-start-1 h-5 w-32" />
          <CardAction className="flex gap-2 max-sm:col-span-2 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch max-sm:pt-3 max-sm:*:flex-1">
            <Skeleton className="h-8 w-31" />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Skeleton className="h-21 rounded-lg sm:h-26" />
            <Skeleton className="h-21 rounded-lg sm:h-26" />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <Skeleton key={card} className="h-10.5 rounded-lg sm:h-14.5" />
            ))}
          </div>
        </CardContent>
        <CardFooter>
          <Skeleton className="h-5 w-52" />
        </CardFooter>
      </Card>
      <Card aria-hidden="true">
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((tile) => (
            <Skeleton key={tile} className="h-16 rounded-md" />
          ))}
        </CardContent>
      </Card>
    </PageMain>
  );
}
