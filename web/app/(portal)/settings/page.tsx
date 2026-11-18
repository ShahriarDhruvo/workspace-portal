import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { AgentInfo, WorkspaceInfo } from "@portal/core";
import { saveName } from "@/lib/actions/settings";
import { startingAgent } from "@/lib/agent-choice";
import { formatVersion } from "@/lib/format";
import { gateway, toApiError } from "@/lib/gateway";
import { requireUser } from "@/lib/session";
import { ProfileForm } from "@/components/admin/profile-form";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { FormError } from "@/components/forms/form-error";
import { PageHeading } from "@/components/layout/page-heading";
import { PageMain } from "@/components/layout/page-main";
import { Section } from "@/components/layout/section";
import { ElectricityPriceSection } from "@/components/settings/electricity-price-section";
import { HarnessPicker } from "@/components/settings/harness-picker";
import { ThemePicker } from "@/components/settings/theme-picker";
import { Badge } from "@/components/ui/badge";
import { CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Settings" };

/** One labelled value of the Account card: a small muted label over a 32px row (a button's height). */
function Fact({ label, labelId, children }: { label: string; labelId?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt id={labelId} className="text-12 text-muted-foreground">
        {label}
      </dt>
      <dd className="flex h-8 min-w-0 items-center text-14">{children}</dd>
    </div>
  );
}

/**
 * Settings of the signed-in user's own account, also for an administrator viewing someone else's workspace:
 * the account (username, role and the theme switch, then the name, which the user can change), the harness,
 * and the password.
 */
export default async function SettingsPage() {
  const { user } = await requireUser();

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
    <PageMain width="md">
      <PageHeading title="Settings" />
      <div className="flex flex-col gap-4">
        <Section id="account" title="Account">
          <ProfileForm action={saveName} firstName={user.firstName} middleName={user.middleName} lastName={user.lastName}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
              <Fact label="Username">
                <span className="truncate font-mono text-13" title={user.username}>
                  {user.username}
                </span>
              </Fact>
              <Fact label="Role">{user.role === "admin" ? <Badge>Admin</Badge> : <Badge variant="outline">User</Badge>}</Fact>
              <Fact label="Theme" labelId="theme-label">
                <ThemePicker labelledBy="theme-label" />
              </Fact>
            </dl>
          </ProfileForm>
        </Section>

        <Section
          id="harness"
          title="Harness"
          description={only ? "The coding agent your workspace runs." : "The coding agent your workspace starts with."}
        >
          <CardContent>
            {harnessError ? (
              <FormError>The harnesses can&apos;t be listed right now: {harnessError}</FormError>
            ) : chosen === null ? (
              <p className="text-14 text-muted-foreground">No harness is enabled on this server. Ask the administrator.</p>
            ) : only ? (
              <p className="flex flex-wrap items-baseline gap-x-2 text-14">
                <span className="font-medium">{only.name}</span>
                <span className="font-mono text-12 text-muted-foreground">{formatVersion(only.version)}</span>
              </p>
            ) : (
              <HarnessPicker
                agents={agents}
                chosen={chosen}
                running={running ? { agent: running.agent, busy: running.busy, connections: running.connections } : null}
                labelledBy="harness-title"
              />
            )}
          </CardContent>
        </Section>

        <Section id="password" title="Password">
          <ChangePasswordForm username={user.username} temporary={false} />
        </Section>

        {user.role === "admin" ? <ElectricityPriceSection /> : null}
      </div>
    </PageMain>
  );
}
