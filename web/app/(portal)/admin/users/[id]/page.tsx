import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  AGENT_NAMES,
  displayName,
  users,
  type AgentInfo,
  type WorkspaceInfo,
} from "@portal/core";
import { updateProfile } from "@/lib/actions/admin";
import { startingAgent } from "@/lib/agent-choice";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { formatVersion, initials, summarizeWorkspace, workspaceState } from "@/lib/format";
import { gateway, toApiError } from "@/lib/gateway";
import { requireAdmin } from "@/lib/session";
import { userIdSchema } from "@/lib/validation";
import { hasContainer, runningWorkspace } from "@/lib/workspace-kind";
import { BackLink } from "@/components/admin/back-link";
import { OnlineAccess } from "@/components/admin/online-access";
import { OpenWorkspaceForm } from "@/components/admin/open-workspace-form";
import { ProfileForm } from "@/components/admin/profile-form";
import { UserDialogButton } from "@/components/admin/user-dialogs";
import { UserHarness } from "@/components/admin/user-harness";
import { WorkspaceRefresh } from "@/components/admin/workspace-refresh";
import { UserAvatar } from "@/components/brand";
import { FormError } from "@/components/forms/form-error";
import { PageMain } from "@/components/layout/page-main";
import { Section } from "@/components/layout/section";
import { LocalTime } from "@/components/local-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { KeyIcon, StopIcon, TrashIcon, UserCheckIcon, UserXIcon, WarningIcon } from "@/components/ui/icons";
import { KindBadge } from "@/components/workspace/kind-badge";
import { StatusPill } from "@/components/workspace/status-pill";

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
  let enabled: AgentInfo[] | null = null;
  let agentsError: string | null = null;
  try {
    enabled = await gateway.agents();
  } catch (error) {
    agentsError = toApiError(error).message;
  }
  const running = workspace?.status === "running" || workspace?.status === "starting";
  const pill = workspaceError ? null : workspaceState(workspace ?? { status: "stopped", ready: false, busy: false });
  // The harness the workspace starts with: the user's choice while enabled, else the install's default.
  const chosen = enabled ? startingAgent(user.agent, enabled) : null;
  // The harness the workspace runs; stopped, the one it starts with next.
  const harness = running ? (workspace?.agent ?? null) : enabled ? chosen : user.agent;
  const version = running ? (workspace?.agentVersion ?? null) : (enabled?.find((agent) => agent.id === harness)?.version ?? null);
  // The facts behind the status pill (idle time, memory, why it stopped), for its tooltip.
  const summary = workspaceError ? null : summarizeWorkspace(workspace, config.idleTimeoutMinutes);
  const facts = summary ? [summary.detail, summary.title].filter((fact) => fact !== null).join(" · ") : "";
  const dialogUser = {
    id: user.id,
    name,
    username: user.username,
    busy: workspace?.busy ?? false,
    running: workspace ? runningWorkspace(workspace) : null,
    harnesses: enabled?.map((agent) => agent.id) ?? null,
  };

  return (
    <PageMain width="md">
      <WorkspaceRefresh userId={user.id} shown={pill} />
      <div className="flex flex-col gap-3">
        <BackLink href="/admin/users">Users</BackLink>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {/* Not on a phone, where its width goes to the pills. */}
            <div className="max-sm:hidden">
              <UserAvatar initials={initials(user.firstName, user.lastName)} size="lg" />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="text-18 font-semibold wrap-anywhere">{name}</h1>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 font-mono text-12 break-all text-muted-foreground">{user.username}</span>
                {user.role === "admin" ? <Badge>Admin</Badge> : <Badge variant="outline">User</Badge>}
                {user.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Deactivated</Badge>}
                {user.mustChangePassword ? <Badge variant="warning">Temporary password</Badge> : null}
                {pill ? (
                  <StatusPill state={pill} title={facts || undefined} />
                ) : (
                  <Badge variant="secondary" title={workspaceError ?? undefined}>
                    Workspace status unknown
                  </Badge>
                )}
                {workspace && hasContainer(workspace.status) ? <KindBadge kind={workspace.kind} /> : null}
                {harness ? (
                  <Badge variant="outline" title={version ? `${AGENT_NAMES[harness]} ${formatVersion(version)}` : undefined}>
                    <span className="sr-only">Harness: </span>
                    {AGENT_NAMES[harness]}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            {running ? (
              <UserDialogButton kind="stop" user={dialogUser} icon={<StopIcon />}>
                Stop
              </UserDialogButton>
            ) : null}
            <OpenWorkspaceForm userId={user.id} variant="default" size="default" />
          </div>
        </div>
      </div>

      {workspace?.status === "error" ? (
        <Alert variant="destructive" role="status">
          <WarningIcon />
          <AlertTitle>The workspace couldn&apos;t start</AlertTitle>
          {workspace.lastError ? <AlertDescription>{workspace.lastError}</AlertDescription> : null}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4">
        <Section id="profile" title="Profile">
          <ProfileForm action={updateProfile} userId={user.id} firstName={user.firstName} middleName={user.middleName} lastName={user.lastName} />
        </Section>

        <Section id="workspace" title="Workspaces">
          <CardContent>
            <OnlineAccess
              user={dialogUser}
              allowed={user.onlineAllowed}
              onlineRunning={workspace?.kind === "online" && running}
              portalOff={workspace?.online === "off"}
            />
          </CardContent>
          <CardFooter>
            {/* Which workspace can't be erased is the gateway's to say: no dialog while it can't. */}
            <UserDialogButton
              kind="erase"
              user={dialogUser}
              icon={<TrashIcon />}
              blockedReason={workspaceError ? "The workspace status is unknown right now." : null}
            >
              Erase files…
            </UserDialogButton>
          </CardFooter>
        </Section>

        <Section
          id="harness"
          title="Harness"
          description={
            enabled?.length === 1 ? (
              <>The coding agent {name}&apos;s workspace runs.</>
            ) : (
              <>The coding agent {name}&apos;s workspace starts with.</>
            )
          }
        >
          <CardContent>
            {agentsError ? (
              <FormError>The harnesses can&apos;t be listed right now: {agentsError}</FormError>
            ) : !enabled || chosen === null ? (
              <p className="text-14 text-muted-foreground">No harness is enabled on this server.</p>
            ) : enabled.length === 1 ? (
              <p className="flex flex-wrap items-baseline gap-x-2 text-14">
                <span className="font-medium">{enabled[0]!.name}</span>
                <span className="font-mono text-12 text-muted-foreground">{formatVersion(enabled[0]!.version)}</span>
              </p>
            ) : (
              <UserHarness
                agents={enabled}
                chosen={chosen}
                running={
                  running && workspace ? { agent: workspace.agent, busy: workspace.busy, connections: workspace.connections } : null
                }
                labelledBy="harness-title"
                owner={{ id: user.id, name }}
              />
            )}
          </CardContent>
        </Section>

        <Section
          id="account"
          title="Account"
          description={
            <>
              <span className="whitespace-nowrap">
                Created <LocalTime at={user.createdAt} />
              </span>
              {" · "}
              <span className="whitespace-nowrap">
                Last sign-in {user.lastLoginAt ? <LocalTime at={user.lastLoginAt} relative /> : "never"}
              </span>
            </>
          }
        >
          {/* The administrator's own account can't be deactivated or deleted; its password is changed in Settings. */}
          <CardFooter className="flex-wrap gap-2">
            {isSelf ? (
              <Button asChild variant="outline">
                <Link href="/settings#password">
                  <KeyIcon />
                  Change password
                </Link>
              </Button>
            ) : (
              <>
                <UserDialogButton kind="reset" user={dialogUser} icon={<KeyIcon />}>
                  Reset password…
                </UserDialogButton>
                {user.active ? (
                  <UserDialogButton kind="deactivate" user={dialogUser} icon={<UserXIcon />}>
                    Deactivate…
                  </UserDialogButton>
                ) : (
                  <UserDialogButton kind="activate" user={dialogUser} icon={<UserCheckIcon />}>
                    Activate…
                  </UserDialogButton>
                )}
                <div className="sm:ml-auto">
                  <UserDialogButton kind="delete" user={dialogUser} icon={<TrashIcon />} danger>
                    Delete…
                  </UserDialogButton>
                </div>
              </>
            )}
          </CardFooter>
        </Section>
      </div>
    </PageMain>
  );
}
