import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AGENT_NAMES, displayName } from "@portal/db";
import { startingAgent } from "@/lib/agent-choice";
import { formatVersion, initials } from "@/lib/format";
import { gateway, toApiError } from "@/lib/gateway";
import type { AgentInfo, WorkspaceInfo } from "@/lib/gateway-types";
import { requireUser } from "@/lib/session";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { FormError } from "@/components/forms/form-error";
import { AppHeader } from "@/components/layout/app-header";
import { HarnessPicker } from "@/components/settings/harness-picker";
import { ThemePicker } from "@/components/settings/theme-picker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Settings" };

/** One section of the page: a card with its title, a line about it, and its controls. */
function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-16" aria-labelledby={`${id}-title`} role="region">
      <CardHeader>
        <CardTitle>
          <h2 id={`${id}-title`} className="text-14">
            {title}
          </h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Settings of the signed-in user's own account, also for an administrator viewing someone else's workspace. */
export default async function SettingsPage() {
  const { user } = await requireUser();
  const name = displayName(user);
  const viewer = { name, initials: initials(user.firstName, user.lastName), isAdmin: user.role === "admin" };

  let agents: AgentInfo[] = [];
  let workspace: WorkspaceInfo | null = null;
  let harnessError: string | null = null;
  try {
    [agents, workspace] = await Promise.all([gateway.agents(), gateway.getWorkspace(user.id)]);
  } catch (error) {
    harnessError = toApiError(error).message;
  }
  const chosen = startingAgent(user.agent, agents);
  // With one harness there is nothing to choose: it is shown as plain information.
  const only = agents.length === 1 ? agents[0] : undefined;
  const running = workspace && (workspace.status === "starting" || workspace.status === "running") ? workspace : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader viewer={viewer} />
      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 py-10 max-sm:py-6">
        <h1 className="text-18 font-semibold">Settings</h1>

        <SettingsSection id="account" title="Account" description="Set by your administrator.">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-14">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="min-w-0 wrap-anywhere">{name}</dd>
            <dt className="text-muted-foreground">Username</dt>
            <dd className="min-w-0 font-mono text-13 break-all">{user.username}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd>{user.role === "admin" ? <Badge>Admin</Badge> : <Badge variant="outline">User</Badge>}</dd>
          </dl>
        </SettingsSection>

        <SettingsSection
          id="harness"
          title="Harness"
          description={agents.length > 1 ? "The coding agent your workspace starts with. Saved as soon as you choose." : "The coding agent your workspace runs."}
        >
          {harnessError ? (
            <FormError>The harnesses can&apos;t be listed right now: {harnessError}</FormError>
          ) : chosen === null ? (
            <p className="text-14 text-muted-foreground">No harness is enabled on this server. Ask the administrator.</p>
          ) : only ? (
            <p className="flex flex-wrap items-baseline gap-x-2 text-14">
              <span className="font-medium">{only.name}</span>
              <span className="font-mono text-12 text-muted-foreground">{formatVersion(only.version)}</span>
              <span className="basis-full text-13 text-muted-foreground">{only.description}</span>
            </p>
          ) : (
            <HarnessPicker
              agents={agents}
              chosen={chosen}
              running={running ? { agent: running.agent, busy: running.busy, connections: running.connections } : null}
              agentNames={AGENT_NAMES}
            />
          )}
        </SettingsSection>

        <SettingsSection id="appearance" title="Appearance" description="Also on the sun and moon button in the top bar.">
          <ThemePicker />
        </SettingsSection>

        <SettingsSection id="password" title="Password" description="Changing it signs out your other sessions.">
          <ChangePasswordForm username={user.username} temporary={false} />
        </SettingsSection>
      </main>
    </div>
  );
}
