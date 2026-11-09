import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { AGENT_NAMES, displayName, users } from "@portal/db";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { agentLabel, initials, summarizeWorkspace } from "@/lib/format";
import { gateway, toApiError } from "@/lib/gateway";
import type { WorkspaceInfo } from "@/lib/gateway-types";
import { requireAdmin } from "@/lib/session";
import { userIdSchema } from "@/lib/validation";
import { BackLink } from "@/components/admin/back-link";
import { OpenWorkspaceForm } from "@/components/admin/open-workspace-form";
import { ProfileForm } from "@/components/admin/profile-form";
import { UserDialogButton } from "@/components/admin/user-dialogs";
import { Avatar } from "@/components/brand";
import { LocalTime } from "@/components/local-time";
import { buttonClass } from "@/components/ui/button";
import { Card, CardRow, Section } from "@/components/ui/card";
import { StatusDot, Tag } from "@/components/ui/tag";

function loadUser(id: string) {
  const parsed = userIdSchema.safeParse(id);
  if (!parsed.success) return undefined;
  return getDb().select().from(users).where(eq(users.id, parsed.data)).get();
}

export async function generateMetadata({ params }: PageProps<"/admin/users/[id]">): Promise<Metadata> {
  const user = loadUser((await params).id);
  return { title: user ? displayName(user) : "User" };
}

export default async function UserPage({ params }: PageProps<"/admin/users/[id]">) {
  const session = await requireAdmin();
  const user = loadUser((await params).id);
  if (!user) notFound();

  const isSelf = user.id === session.user.id;
  const name = displayName(user);
  let workspace: WorkspaceInfo | null = null;
  let workspaceError: string | null = null;
  try {
    workspace = await gateway.getWorkspace(user.id);
  } catch (error) {
    workspaceError = toApiError(error).message;
  }
  const summary = workspace ? summarizeWorkspace(workspace, config.idleTimeoutMinutes) : null;
  const dialogUser = { id: user.id, name, username: user.username, busy: workspace?.busy ?? false };
  const running = workspace?.status === "running" || workspace?.status === "starting";

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6">
      <div className="flex flex-col gap-3">
        <BackLink href="/admin">Users</BackLink>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar initials={initials(user.firstName, user.lastName)} size="lg" />
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="truncate text-18 font-semibold">{name}</h1>
              <div className="flex flex-wrap items-center gap-2 text-13 text-fg-muted">
                <span className="font-mono text-12">{user.username}</span>
                {user.role === "admin" ? <Tag tone="solid">Admin</Tag> : <Tag tone="outline">User</Tag>}
                {user.active ? <Tag tone="success">Active</Tag> : <Tag tone="neutral">Disabled</Tag>}
                {user.mustChangePassword ? <Tag tone="warning">Temporary password</Tag> : null}
              </div>
            </div>
          </div>
          <OpenWorkspaceForm userId={user.id} variant="primary" size="md" />
        </div>
      </div>

      <Section title="Profile" description="Shown everywhere as first, middle and last name.">
        <Card>
          <ProfileForm userId={user.id} firstName={user.firstName} middleName={user.middleName} lastName={user.lastName} />
        </Card>
      </Section>

      <Section title="Workspace">
        <Card>
          <CardRow
            title={
              summary ? (
                <span className="flex items-center gap-2" title={summary.title ?? undefined}>
                  <StatusDot tone={summary.tone} pulse={summary.label === "Working"} />
                  {summary.label}
                </span>
              ) : (
                "Status unavailable"
              )
            }
            action={running ? <UserDialogButton kind="stop" user={dialogUser}>Stop workspace</UserDialogButton> : null}
          >
            {summary
              ? (summary.detail ?? summary.title ?? "Starts when the user signs in or opens it.")
              : workspaceError}
          </CardRow>
          {workspace ? (
            <CardRow title="Agent">
              {agentLabel(workspace, AGENT_NAMES) ?? "None yet: chosen when the workspace first starts."}
            </CardRow>
          ) : null}
        </Card>
      </Section>

      <Section title="Account">
        <Card>
          {isSelf ? (
            <CardRow
              title="Password"
              action={
                <Link href="/change-password" className={buttonClass("outline", "sm")}>
                  Change password
                </Link>
              }
            >
              This is the administrator account. It can&apos;t be deactivated or deleted.
            </CardRow>
          ) : (
            <>
              <CardRow title="Password" action={<UserDialogButton kind="reset" user={dialogUser}>Reset password…</UserDialogButton>}>
                Signs {user.firstName} out everywhere and issues a new temporary password.
              </CardRow>
              <CardRow
                title={user.active ? "Active" : "Deactivated"}
                action={
                  user.active ? (
                    <UserDialogButton kind="deactivate" user={dialogUser}>
                      Deactivate…
                    </UserDialogButton>
                  ) : (
                    <UserDialogButton kind="activate" user={dialogUser}>
                      Activate…
                    </UserDialogButton>
                  )
                }
              >
                {user.active
                  ? "Deactivating signs them out and stops their workspace. Files are kept."
                  : "They can't sign in until the account is activated again."}
              </CardRow>
              <CardRow
                title="Delete user"
                action={
                  <UserDialogButton kind="delete" user={dialogUser} danger>
                    Delete…
                  </UserDialogButton>
                }
              >
                Permanently removes the account and all of its workspace files.
              </CardRow>
            </>
          )}
        </Card>
        <p className="px-0.5 text-12 text-fg-muted">
          Created <LocalTime at={user.createdAt} /> · Last sign-in{" "}
          {user.lastLoginAt ? <LocalTime at={user.lastLoginAt} /> : "never"}
        </p>
      </Section>
    </div>
  );
}
