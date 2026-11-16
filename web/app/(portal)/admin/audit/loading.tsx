import { PageMain } from "@/components/layout/page-main";
import { HeadingSkeleton, TableSkeleton } from "@/components/layout/skeletons";

const COLUMNS = ["Time", "Actor", "Action", "Target", "Details"];

/** The audit log while it loads: its heading and a full page (30 rows) of the table. */
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
