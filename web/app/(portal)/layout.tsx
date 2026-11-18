import type { ReactNode } from "react";
import { displayName } from "@portal/core";
import { initials } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { AppHeader } from "@/components/layout/app-header";
import { ViewingBanner } from "@/components/workspace/viewing-banner";

/**
 * Every signed-in page but the workspace itself: the top bar, then the page. Layouts are not re-rendered on client
 * navigation: pages check access themselves.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const { user, target, actingAs } = await requireUser();
  const viewer = { name: displayName(user), initials: initials(user.firstName, user.lastName), isAdmin: user.role === "admin" };
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {actingAs ? (
        <ViewingBanner returnHref={`/admin/users/${target.id}/workspace`}>
          You are viewing {displayName(target)}&apos;s workspace
        </ViewingBanner>
      ) : null}
      <AppHeader viewer={viewer} />
      {children}
    </div>
  );
}
