import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { displayName, users } from "@portal/core";
import { config } from "@/lib/config";
import { workspaceFrame } from "@/lib/workspace-frame";
import { getDb } from "@/lib/db";
import { initials } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { userIdSchema } from "@/lib/validation";
import { AppHeader } from "@/components/layout/app-header";
import { PageMain } from "@/components/layout/page-main";
import { BackLink } from "@/components/admin/back-link";
import { OpenWorkspaceForm } from "@/components/admin/open-workspace-form";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ViewingBanner } from "@/components/workspace/viewing-banner";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export const metadata: Metadata = { title: "Viewing workspace" };

export default async function ViewWorkspacePage({ params }: PageProps<"/admin/users/[id]/workspace">) {
  const session = await requireAdmin();
  const id = userIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const isSelf = id.data === session.user.id;
  // The admin's own workspace is on Home (while the session views someone else's, it explains how to get back).
  if (isSelf && !session.actingAs) redirect("/");
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
        back={{ href: "/admin/users", label: "Users" }}
        title={`Your session is viewing ${displayName(session.target)}'s workspace`}
        open={<OpenWorkspaceForm userId={user.id} label="Open my workspace" variant="default" size="default" />}
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
        open={<OpenWorkspaceForm userId={user.id} variant="default" size="default" />}
      >
        The audit log records it, and {user.firstName} sees &ldquo;Admin connected&rdquo; while you are in it.
      </OpenPanel>
    );
  }

  return (
    <WorkspaceShell
      viewer={{ name: viewerName, initials: viewerInitials, isAdmin: true }}
      target={{ id: user.id, name, isViewer: false }}
      frames={{ private: workspaceFrame(session, "private"), online: workspaceFrame(session, "online") }}
      idleTimeoutMinutes={config.idleTimeoutMinutes}
      banner={<ViewingBanner>Viewing {name}&apos;s workspace</ViewingBanner>}
    />
  );
}

/** What opening a workspace means, in one line, with the button that does it. */
function OpenPanel(props: {
  viewer: { name: string; initials: string };
  back: { href: string; label: string };
  title: string;
  open: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader viewer={{ ...props.viewer, isAdmin: true }} />
      <PageMain width="sm" className="gap-4">
        <BackLink href={props.back.href}>{props.back.label}</BackLink>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="text-16">{props.title}</h1>
            </CardTitle>
            <CardDescription>{props.children}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-end">{props.open}</CardFooter>
        </Card>
      </PageMain>
    </div>
  );
}
