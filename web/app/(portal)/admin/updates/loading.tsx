import { PageMain } from "@/components/layout/page-main";
import { ButtonSkeleton, HeadingSkeleton } from "@/components/layout/skeletons";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** The two cards every install has (Gufo and a harness): the widths of their titles and sources. */
const CARDS = [
  { title: "max-w-24", source: "max-w-72" },
  { title: "max-w-24", source: "max-w-36" },
];

/** The Updates page while it loads: each card as VersionCard draws it, so these don't move when the page arrives (a further harness adds its card below). */
export default function UpdatesLoading() {
  return (
    <PageMain width="lg">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <HeadingSkeleton className="mr-auto w-24" />
        <div className="max-sm:order-last max-sm:basis-full sm:mr-1">
          <Skeleton className="h-4 w-28" />
        </div>
        <ButtonSkeleton className="h-7 w-36" />
      </div>
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading updates">
        {CARDS.map((card, index) => (
          <Card key={index} aria-hidden="true">
            <CardHeader>
              <CardTitle>
                <Skeleton className={`h-6 w-full ${card.title}`} />
              </CardTitle>
              <CardDescription>
                <Skeleton className={`h-4 w-full ${card.source}`} />
              </CardDescription>
              <CardAction>
                <Skeleton className="h-5 w-24 rounded-4xl" />
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              <div className="flex flex-col gap-1">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-8 w-28" />
              </div>
              <ButtonSkeleton className="w-32" />
            </CardContent>
            <CardFooter className="min-h-11 justify-between gap-3 bg-transparent px-4 py-2.5">
              <Skeleton className="h-5 w-56 max-w-full" />
              <Skeleton className="size-4" />
            </CardFooter>
          </Card>
        ))}
      </div>
    </PageMain>
  );
}
