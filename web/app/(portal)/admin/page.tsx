import type { Metadata } from "next";
import { AGENT_NAMES } from "@portal/db";
import { getDb } from "@/lib/db";
import { loadEnergyMonth } from "@/lib/energy";
import { requireAdmin } from "@/lib/session";
import { PageMain } from "@/components/layout/page-main";
import { UsageLive } from "@/components/admin/usage/usage-live";

export const metadata: Metadata = { title: "Usage" };

/** Admin > Usage: the live view (the browser streams it) and this month's energy, rendered here. */
export default async function UsagePage() {
  await requireAdmin();
  return (
    <PageMain width="lg">
      <UsageLive agentNames={AGENT_NAMES} energy={loadEnergyMonth(getDb())} />
    </PageMain>
  );
}
