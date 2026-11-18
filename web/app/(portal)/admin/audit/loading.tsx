import { PageMain } from "@/components/layout/page-main";
import { HeadingSkeleton, TableSkeleton } from "@/components/layout/skeletons";

const COLUMNS = ["Time", "Actor", "Action", "Target", "Details"];

export default function AuditLoading() {
  return (
    <PageMain width="lg">
      <HeadingSkeleton className="w-24" />
      <div aria-busy="true" aria-label="Loading the audit log">
        <TableSkeleton columns={COLUMNS} rows={30} />
      </div>
    </PageMain>
  );
}
