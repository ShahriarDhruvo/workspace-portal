import type { Metadata } from "next";
import Link from "next/link";
import { asc, desc } from "drizzle-orm";
import { AGENT_NAMES, users } from "@portal/core";
import { getDb } from "@/lib/db";
import { gateway } from "@/lib/gateway";
import { loadAdminOverview } from "@/lib/overview";
import { requireAdmin } from "@/lib/session";
import { toUserSummary } from "@/lib/user-summary";
import { UsersDashboard } from "@/components/admin/dashboard";
import { PageHeading } from "@/components/layout/page-heading";
import { PageMain } from "@/components/layout/page-main";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Users" };

/** Admin > Users: everyone, with New user, over the running workspaces. */
export default async function UsersPage() {
  const session = await requireAdmin();
  const rows = getDb()
    .select()
    .from(users)
    .orderBy(desc(users.role), asc(users.firstName), asc(users.lastName), asc(users.username))
    .all();
  const [overview, enabled] = await Promise.all([loadAdminOverview(), gateway.agents().catch(() => null)]);
  return (
    <PageMain width="lg">
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
      />
      <UsersDashboard
        users={rows.map(toUserSummary)}
        initialOverview={overview}
        currentAdminId={session.user.id}
        agentNames={AGENT_NAMES}
        enabledAgents={enabled?.map((agent) => ({ id: agent.id })) ?? null}
      />
    </PageMain>
  );
}
