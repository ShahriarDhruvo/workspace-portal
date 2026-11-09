import type { Metadata } from "next";
import Link from "next/link";
import { asc, desc } from "drizzle-orm";
import { users } from "@portal/db";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { loadAdminOverview } from "@/lib/overview";
import { requireAdmin } from "@/lib/session";
import { toUserSummary } from "@/lib/user-summary";
import { AdminDashboard } from "@/components/admin/dashboard";
import { buttonClass } from "@/components/ui/button";
import { PageHeading } from "@/components/ui/card";
import { PlusIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Users" };

export default async function AdminPage() {
  const session = await requireAdmin();
  const rows = getDb()
    .select()
    .from(users)
    .orderBy(desc(users.role), asc(users.firstName), asc(users.lastName), asc(users.username))
    .all();
  const overview = await loadAdminOverview();
  return (
    <>
      <PageHeading
        title="Dashboard"
        actions={
          <Link href="/admin/users/new" className={buttonClass("primary")}>
            <PlusIcon />
            New user
          </Link>
        }
      >
        Accounts, workspaces and host load.
      </PageHeading>
      <AdminDashboard
        users={rows.map(toUserSummary)}
        initialOverview={overview}
        currentAdminId={session.user.id}
        idleTimeoutMinutes={overview.stats?.idleTimeoutMinutes ?? config.idleTimeoutMinutes}
      />
    </>
  );
}
