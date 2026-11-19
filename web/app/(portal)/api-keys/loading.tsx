import { PageMain } from "@/components/layout/page-main";
import { ButtonSkeleton, HeadingSkeleton, SectionSkeleton } from "@/components/layout/skeletons";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** The page of someone with one key in use: the connection card, Keys, then Usage's card and table. */
export default function ApiKeysLoading() {
  return (
    <PageMain width="md">
      <HeadingSkeleton className="w-10" />
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading the API page">
        <SectionSkeleton description>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-7 w-32" />
          </div>
        </SectionSkeleton>
        <div className="flex flex-col gap-3">
          <div className="flex h-8 items-center justify-between">
            <Skeleton className="h-6 w-16" />
            <ButtonSkeleton className="w-28" />
          </div>
          <Card className="h-22.5" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="my-1 h-6 w-16" />
          <Card className="py-0">
            <CardContent className="flex flex-col gap-4 p-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="-mt-1 h-24 rounded-lg" />
              <Skeleton className="h-40" />
            </CardContent>
          </Card>
          <Card className="h-18.5" />
        </div>
      </div>
    </PageMain>
  );
}
