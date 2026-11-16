import { PageMain } from "@/components/layout/page-main";
import { ButtonSkeleton, FieldSkeleton, HeadingSkeleton } from "@/components/layout/skeletons";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The new-user form while it loads: the back link, the heading, the name row, username and password, the Online
 * switch, buttons.
 */
export default function NewUserLoading() {
  return (
    <PageMain width="md">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-7 w-16" />
        <HeadingSkeleton className="w-24" />
      </div>
      <Card aria-busy="true" aria-label="Loading the form">
        <CardContent className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-3">
            <FieldSkeleton />
            <FieldSkeleton />
            <FieldSkeleton />
          </div>
          <div className="grid grid-cols-1 items-start gap-x-4 gap-y-5 sm:grid-cols-2">
            <FieldSkeleton hint />
            <FieldSkeleton />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-[18.4px] w-8 rounded-full" />
            <Skeleton className="h-5 w-32" />
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <ButtonSkeleton className="w-16" />
          <ButtonSkeleton />
        </CardFooter>
      </Card>
    </PageMain>
  );
}
