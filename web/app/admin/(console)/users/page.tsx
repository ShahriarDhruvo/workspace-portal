import type { Metadata } from "next";
import Link from "next/link";
import { asc, desc } from "drizzle-orm";
import { AGENT_NAMES, users } from "@portal/db";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { gateway } from "@/lib/gateway";
import { loadAdminOverview } from "@/lib/overview";
import { requireAdmin } from "@/lib/session";
import { toUserSummary } from "@/lib/user-summary";
import { UsersDashboard } from "@/components/admin/dashboard";
import { PageHeading } from "@/components/layout/page-heading";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const session = await requireAdmin();
  const rows = getDb()
    .select()
    .from(users)
    .orderBy(desc(users.role), asc(users.firstName), asc(users.lastName), asc(users.username))
    .all();
  const [overview, enabled] = await Promise.all([loadAdminOverview(), gateway.agents().catch(() => null)]);
  return (
    <>
      <PageHeading
        title="Users"
        actions={
          <Button asChild>
            <Link href="/admin/users/new">
              <PlusIcon />
              New user
            </Link>
          </Button>
        }
      >
        Accounts and their workspaces.
      </PageHeading>
      <UsersDashboard
        users={rows.map(toUserSummary)}
        initialOverview={overview}
        currentAdminId={session.user.id}
        idleTimeoutMinutes={overview.stats?.idleTimeoutMinutes ?? config.idleTimeoutMinutes}
        agentNames={AGENT_NAMES}
        enabledAgents={enabled?.map((agent) => ({ id: agent.id })) ?? null}
      />
    </>
  );
}
