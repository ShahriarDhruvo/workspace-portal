import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { BackLink } from "@/components/admin/back-link";
import { NewUser } from "@/components/admin/new-user-form";
import { PageHeading } from "@/components/layout/page-heading";
import { PageMain } from "@/components/layout/page-main";

export const metadata: Metadata = { title: "New user" };

/** A new account: always a regular user, with a temporary password they replace at first sign-in. */
export default async function NewUserPage() {
  await requireAdmin();
  return (
    <PageMain width="md">
      <div className="flex flex-col gap-3">
        <BackLink href="/admin/users">Users</BackLink>
        <PageHeading title="New user" />
      </div>
      <NewUser />
    </PageMain>
  );
}
