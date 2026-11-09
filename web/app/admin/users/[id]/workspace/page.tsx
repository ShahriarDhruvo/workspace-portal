import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { displayName, users } from "@portal/db";
import { config } from "@/lib/config";
import { workspaceFrame } from "@/lib/workspace-frame";
import { getDb } from "@/lib/db";
import { initials } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { userIdSchema } from "@/lib/validation";
import { AdminHeader } from "@/components/admin/admin-header";
import { BackLink } from "@/components/admin/back-link";
import { OpenWorkspaceForm } from "@/components/admin/open-workspace-form";
import { ViewingBanner } from "@/components/workspace/viewing-banner";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export const metadata: Metadata = { title: "Viewing workspace" };

export default async function ViewWorkspacePage({ params }: PageProps<"/admin/users/[id]/workspace">) {
  const session = await requireAdmin();
  const id = userIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  if (id.data === session.user.id) redirect("/workspace");
  const user = getDb().select().from(users).where(eq(users.id, id.data)).get();
  if (!user) notFound();

  const name = displayName(user);
  const viewer = session.user;
  const viewerName = displayName(viewer);
  const viewerInitials = initials(viewer.firstName, viewer.lastName);

  if (!(session.actingAs && session.target.id === user.id)) {
    return (
      <div className="min-h-dvh bg-base">
        <AdminHeader name={viewerName} initials={viewerInitials} />
        <main className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-5 py-6 sm:px-6">
          <BackLink href={`/admin/users/${user.id}`}>{name}</BackLink>
          <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-16 leading-snug font-medium">You are not viewing {name}&apos;s workspace</h1>
              <p className="text-14 text-fg-muted">
                Opening it points your session at their workspace, starts it if needed, and is recorded in the audit
                log. {user.firstName} sees an &ldquo;Admin connected&rdquo; notice while you are in it.
              </p>
            </div>
            <div className="flex justify-end">
              <OpenWorkspaceForm userId={user.id} variant="primary" size="md" />
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <WorkspaceShell
      viewer={{ name: viewerName, initials: viewerInitials, isAdmin: true }}
      target={{ id: user.id, name, isViewer: false }}
      frame={workspaceFrame(session)}
      idleTimeoutMinutes={config.idleTimeoutMinutes}
      banner={<ViewingBanner>Viewing {name}&apos;s workspace</ViewingBanner>}
    />
  );
}
