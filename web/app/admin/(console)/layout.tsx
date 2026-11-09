import type { ReactNode } from "react";
import { displayName } from "@portal/db";
import { initials } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { AdminHeader } from "@/components/admin/admin-header";
import { ViewingBanner } from "@/components/workspace/viewing-banner";

// Pages re-check the admin role themselves: layouts are not re-rendered on client navigation.
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const { user, target, actingAs } = await requireAdmin();
  return (
    <div className="min-h-dvh bg-base">
      {actingAs ? (
        <ViewingBanner returnHref={`/admin/users/${target.id}/workspace`}>
          Your session is viewing {displayName(target)}&apos;s workspace
        </ViewingBanner>
      ) : null}
      <AdminHeader name={displayName(user)} initials={initials(user.firstName, user.lastName)} />
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-5 py-6 sm:px-6">{children}</main>
    </div>
  );
}
