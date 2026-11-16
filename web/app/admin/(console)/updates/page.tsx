import type { Metadata } from "next";
import { AGENT_NAMES } from "@portal/db";
import { loadAdminAgents, loadAdminEngine } from "@/lib/overview";
import { requireAdmin } from "@/lib/session";
import { UpdatesConsole } from "@/components/admin/agents/updates-console";

export const metadata: Metadata = { title: "Updates" };

/**
 * Updates: the LLM engine (update to a release, roll back, clean up images) and the agents (update, change version,
 * rebuild, clean up images), each on its own card.
 */
export default async function UpdatesPage() {
  await requireAdmin();
  const [agents, engine] = await Promise.all([loadAdminAgents(), loadAdminEngine()]);
  return <UpdatesConsole initialAgents={agents} initialEngine={engine} agentNames={AGENT_NAMES} />;
}
