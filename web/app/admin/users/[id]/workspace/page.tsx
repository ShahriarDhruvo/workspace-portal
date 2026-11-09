import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { AGENT_NAMES, displayName, users } from "@portal/db";
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
  const isSelf = id.data === session.user.id;
  // While the session views someone else's workspace, /workspace shows theirs, not the admin's own.
  if (isSelf && !session.actingAs) redirect("/workspace");
  const user = getDb().select().from(users).where(eq(users.id, id.data)).get();
  if (!user) notFound();

  const name = displayName(user);
  const viewer = session.user;
  const viewerName = displayName(viewer);
  const viewerInitials = initials(viewer.firstName, viewer.lastName);

  if (isSelf) {
    return (
      <OpenPanel
        viewer={{ name: viewerName, initials: viewerInitials }}
        back={{ href: "/admin", label: "Users" }}
        title={`Your session is viewing ${displayName(session.target)}'s workspace`}
        open={<OpenWorkspaceForm userId={user.id} label="Open my workspace" variant="primary" size="md" />}
      >
        Opening your own workspace leaves theirs, which is recorded in the audit log.
      </OpenPanel>
    );
  }

  if (!(session.actingAs && session.target.id === user.id)) {
    return (
      <OpenPanel
        viewer={{ name: viewerName, initials: viewerInitials }}
        back={{ href: `/admin/users/${user.id}`, label: name }}
        title={`You are not viewing ${name}'s workspace`}
        open={<OpenWorkspaceForm userId={user.id} variant="primary" size="md" />}
      >
        Opening it points your session at their workspace, starts it if needed, and is recorded in the audit log.{" "}
        {user.firstName} sees an &ldquo;Admin connected&rdquo; notice while you are in it.
      </OpenPanel>
    );
  }

  return (
    <WorkspaceShell
      viewer={{ name: viewerName, initials: viewerInitials, isAdmin: true }}
      target={{ id: user.id, name, isViewer: false }}
      frame={workspaceFrame(session)}
      idleTimeoutMinutes={config.idleTimeoutMinutes}
      agentNames={AGENT_NAMES}
      banner={<ViewingBanner>Viewing {name}&apos;s workspace</ViewingBanner>}
    />
  );
}

/** A page explaining what opening a workspace does, with the button that does it. */
function OpenPanel(props: {
  viewer: { name: string; initials: string };
  back: { href: string; label: string };
  title: string;
  open: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-base">
      <AdminHeader name={props.viewer.name} initials={props.viewer.initials} />
      <main className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-5 py-6 sm:px-6">
        <BackLink href={props.back.href}>{props.back.label}</BackLink>
        <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-16 leading-snug font-medium">{props.title}</h1>
            <p className="text-14 text-fg-muted">{props.children}</p>
          </div>
          <div className="flex justify-end">{props.open}</div>
        </section>
      </main>
    </div>
  );
}
