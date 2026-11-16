import { PageMain } from "@/components/layout/page-main";
import { ButtonSkeleton, HeadingSkeleton, TableSkeleton } from "@/components/layout/skeletons";

const COLUMNS = ["Name", "Username", "Role", "Account", "Workspace", "Harness", "Last sign-in", ""];

/** The users list while it loads: the heading with New user, and the table's frame with a few rows. */
export default function UsersLoading() {
  return (
    <PageMain width="lg">
      <div className="flex items-center justify-between gap-4">
        <HeadingSkeleton className="w-20" />
        <ButtonSkeleton className="w-28" />
      </div>
      <div aria-busy="true" aria-label="Loading users">
        <TableSkeleton columns={COLUMNS} rows={6} rowHeight="h-11.5" />
      </div>
    </PageMain>
  );
}
