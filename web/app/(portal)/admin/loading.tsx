import { PageMain } from "@/components/layout/page-main";
import { UsageSkeleton } from "@/components/admin/usage/usage-skeleton";

/** Shown at once when Usage is opened, until the page is rendered. */
export default function UsageLoading() {
  return (
    <PageMain width="lg">
      <UsageSkeleton />
    </PageMain>
  );
}
