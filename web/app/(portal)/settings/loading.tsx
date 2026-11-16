import { PageMain } from "@/components/layout/page-main";
import { ButtonSkeleton, FieldSkeleton, HeadingSkeleton, SectionSkeleton } from "@/components/layout/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Settings while it loads: the Account facts, the two harness cards and the password row. */
export default function SettingsLoading() {
  return (
    <PageMain width="md">
      <HeadingSkeleton className="w-24" />
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading settings">
        <SectionSkeleton>
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 sm:gap-x-6">
            {[0, 1, 2, 3].map((fact) => (
              <div key={fact} className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-8 w-full max-w-36" />
              </div>
            ))}
          </div>
        </SectionSkeleton>
        <SectionSkeleton description>
          <div className="grid gap-2 sm:grid-cols-2">
            <Skeleton className="h-10.5 rounded-lg" />
            <Skeleton className="h-10.5 rounded-lg" />
          </div>
        </SectionSkeleton>
        <SectionSkeleton footer={<ButtonSkeleton className="w-32" />}>
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-3">
            <FieldSkeleton />
            <FieldSkeleton />
            <FieldSkeleton />
          </div>
        </SectionSkeleton>
      </div>
    </PageMain>
  );
}
