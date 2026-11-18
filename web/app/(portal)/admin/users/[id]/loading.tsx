import { PageMain } from "@/components/layout/page-main";
import { ButtonSkeleton, FieldRowSkeleton, SectionSkeleton } from "@/components/layout/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function UserLoading() {
  return (
    <PageMain width="md">
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the user">
        <Skeleton className="h-7 w-16" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-10 rounded-full max-sm:hidden" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-5 w-72 max-w-[60vw]" />
            </div>
          </div>
          <ButtonSkeleton className="w-36" />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <SectionSkeleton footer={<ButtonSkeleton className="w-16" />}>
          <FieldRowSkeleton />
        </SectionSkeleton>
        <SectionSkeleton
          footerStart
          footer={
            <>
              <ButtonSkeleton className="w-42" />
              <ButtonSkeleton className="w-42" />
            </>
          }
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-[18.4px] w-8 rounded-full" />
            <Skeleton className="h-5 w-32" />
          </div>
        </SectionSkeleton>
        <SectionSkeleton
          description
          footerStart
          footer={
            <>
              <ButtonSkeleton className="w-36" />
              <ButtonSkeleton className="w-28" />
              <ButtonSkeleton className="sm:ml-auto" />
            </>
          }
        />
      </div>
    </PageMain>
  );
}
