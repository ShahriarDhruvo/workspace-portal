import type { Metadata } from "next";
import type { ReactNode } from "react";
import { saveName } from "@/lib/actions/settings";
import { requireUser } from "@/lib/session";
import { ProfileForm } from "@/components/admin/profile-form";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { PageHeading } from "@/components/layout/page-heading";
import { PageMain } from "@/components/layout/page-main";
import { Section } from "@/components/layout/section";
import { ElectricityPriceSection } from "@/components/settings/electricity-price-section";
import { ThemePicker } from "@/components/settings/theme-picker";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Settings" };

/** One labelled value of the Account card, in a row as tall as a button. */
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

/** Settings of the signed-in user's own account, also for an administrator viewing someone else's workspace. */
export default async function SettingsPage() {
  const { user } = await requireUser();

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

        <Section id="password" title="Password">
          <ChangePasswordForm username={user.username} temporary={false} />
        </Section>

        {user.role === "admin" ? <ElectricityPriceSection /> : null}
      </div>
    </PageMain>
  );
}
