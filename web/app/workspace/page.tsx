import type { Metadata } from "next";
import { displayName } from "@portal/db";
import { config } from "@/lib/config";
import { workspaceFrame } from "@/lib/workspace-frame";
import { initials } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { ViewingBanner } from "@/components/workspace/viewing-banner";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export const metadata: Metadata = { title: "Workspace" };

export default async function WorkspacePage() {
  const session = await requireUser();
  const { user, target, actingAs } = session;
  const targetName = displayName(target);
  return (
    <WorkspaceShell
      viewer={{ name: displayName(user), initials: initials(user.firstName, user.lastName), isAdmin: user.role === "admin" }}
      target={{ id: target.id, name: targetName, isViewer: !actingAs }}
      frame={workspaceFrame(session)}
      idleTimeoutMinutes={config.idleTimeoutMinutes}
      banner={actingAs ? <ViewingBanner>You are viewing {targetName}&apos;s workspace</ViewingBanner> : undefined}
    />
  );
}
