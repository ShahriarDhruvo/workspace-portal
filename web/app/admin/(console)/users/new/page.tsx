import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { BackLink } from "@/components/admin/back-link";
import { NewUser } from "@/components/admin/new-user-form";
import { PageHeading } from "@/components/ui/card";

export const metadata: Metadata = { title: "New user" };

export default async function NewUserPage() {
  await requireAdmin();
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
      <BackLink href="/admin">Users</BackLink>
      <PageHeading title="New user">
        New accounts are regular users with a temporary password they change at first sign-in.
      </PageHeading>
      <NewUser />
    </div>
  );
}
