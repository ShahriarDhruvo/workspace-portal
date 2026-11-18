import { PageMain } from "@/components/layout/page-main";
import { ButtonSkeleton, HeadingSkeleton, TableSkeleton } from "@/components/layout/skeletons";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const COLUMNS = ["Name", "Username", "Role", "Account", "Harness", "Last sign-in", ""];

export default function UsersLoading() {
  return (
    <PageMain width="lg">
      <div className="flex items-center justify-between gap-4">
        <HeadingSkeleton className="w-20" />
        <ButtonSkeleton className="w-28" />
      </div>
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading users">
        <TableSkeleton columns={COLUMNS} rows={6} rowHeight="h-11.5" />
        <Card className="gap-0 py-0">
          <CardHeader className="border-b px-4 py-3">
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <div className="flex h-9 items-center border-b px-4">
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
          <div className="flex h-11 items-center px-4">
            <Skeleton className="h-4 w-full" />
          </div>
        </Card>
      </div>
    </PageMain>
  );
}
