import type { Metadata } from "next";
import { gateway } from "@/lib/gateway";
import { loaded } from "@/lib/overview";
import { requireAdmin } from "@/lib/session";
import { PageMain } from "@/components/layout/page-main";
import { UpdatesConsole } from "@/components/admin/agents/updates-console";

export const metadata: Metadata = { title: "Updates" };

/**
 * Updates: the LLM engine and the agents, each on its own card with its Package images (switch to a version, newer
 * or older, build or rebuild it, remove an image).
 */
export default async function UpdatesPage() {
  await requireAdmin();
  const [agents, engine] = await Promise.all([loaded(gateway.agentVersions()), loaded(gateway.engine())]);
  return (
    <PageMain width="lg">
      <UpdatesConsole initialAgents={agents} initialEngine={engine} />
    </PageMain>
  );
}
