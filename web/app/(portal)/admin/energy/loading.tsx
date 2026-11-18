import { PageMain } from "@/components/layout/page-main";
import { HeadingSkeleton, TableSkeleton } from "@/components/layout/skeletons";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const COLUMNS = ["Day", "LLM server (kWh)", "Portal server (kWh)", "Total (kWh)", "Price", "Cost"];

export default function EnergyLoading() {
  return (
    <PageMain width="lg">
      <div className="flex items-center justify-between gap-4">
        <HeadingSkeleton className="w-20" />
        <Skeleton className="h-8 w-44" />
      </div>
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading energy">
        <Card className="py-0">
          <CardContent className="flex flex-col gap-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-[76px] rounded-lg" />
              <Skeleton className="h-[76px] rounded-lg" />
            </div>
            <Skeleton className="h-40" />
          </CardContent>
        </Card>
        <TableSkeleton columns={COLUMNS} rows={5} rowHeight="h-11" />
      </div>
    </PageMain>
  );
}
