import type { Metadata } from "next";
import { gateway } from "@/lib/gateway";
import { loaded } from "@/lib/overview";
import { requireAdmin } from "@/lib/session";
import { PageMain } from "@/components/layout/page-main";
import { UpdatesConsole } from "@/components/admin/updates/updates-console";

export const metadata: Metadata = { title: "Updates" };

/** Updates: Gufo, the other software on the AI server and the agents, each on its own card with its versions. */
export default async function UpdatesPage() {
  await requireAdmin();
  const [agents, engine, apps] = await Promise.all([loaded(gateway.agentVersions()), loaded(gateway.engine()), loaded(gateway.apps())]);
  return (
    <PageMain width="lg">
      <UpdatesConsole initialAgents={agents} initialEngine={engine} initialApps={apps} />
    </PageMain>
  );
}
