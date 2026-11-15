import type { Metadata } from "next";
import { AGENT_NAMES } from "@portal/db";
import { loadAdminAgents } from "@/lib/overview";
import { requireAdmin } from "@/lib/session";
import { AgentsConsole } from "@/components/admin/agents/agents-console";

export const metadata: Metadata = { title: "Agents" };

/** The agents' versions: update to the latest release or any published version, roll back, rebuild, clean up images. */
export default async function AgentsPage() {
  await requireAdmin();
  return <AgentsConsole initial={await loadAdminAgents()} agentNames={AGENT_NAMES} />;
}
