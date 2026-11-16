import type { Metadata } from "next";
import { AGENT_NAMES } from "@portal/db";
import { requireAdmin } from "@/lib/session";
import { OverviewLive } from "@/components/admin/overview/overview-live";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  await requireAdmin();
  return <OverviewLive agentNames={AGENT_NAMES} />;
}
