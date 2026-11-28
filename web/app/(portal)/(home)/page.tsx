import type { Metadata } from "next";
import Link from "next/link";
import { displayName } from "@portal/core";
import { openMyWorkspace } from "@/lib/actions/admin";
import { config } from "@/lib/config";
import { gateway, toApiError } from "@/lib/gateway";
import { workspaceStatus, type WorkspaceStatusResponse } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { loadUsageToday } from "@/lib/usage";
import { SubmitButton } from "@/components/forms/submit-button";
import { PageMain } from "@/components/layout/page-main";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { HomeCard } from "@/components/workspace/home-card";
import { UsageToday } from "@/components/workspace/usage-today";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const session = await requireUser();
  const { user, target, actingAs } = session;

  let initial: WorkspaceStatusResponse | null = null;
  let initialError: string | null = null;
  if (!actingAs) {
    try {
      initial = await workspaceStatus(gateway.getWorkspace(user.id), session);
    } catch (error) {
      initialError = toApiError(error).message;
    }
  }

  return (
    <PageMain width="sm" className="gap-4">
      {actingAs ? (
        // The workspace routes act on the workspace the session is viewing, so Home shows the admin's own
        // once the session leaves the other one.
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="text-16">You are viewing someone else&apos;s workspace</h1>
            </CardTitle>
            <CardDescription>
              Your session is pointed at {displayName(target)}&apos;s workspace. Leave it to see and start your own.
            </CardDescription>
          </CardHeader>
          <CardFooter className="justify-end gap-2">
            <Button asChild variant="outline">
              <Link href="/workspace">Return to it</Link>
            </Button>
            <form action={openMyWorkspace}>
              <SubmitButton>My workspace</SubmitButton>
            </form>
          </CardFooter>
        </Card>
      ) : (
        <>
          <HomeCard initial={initial} initialError={initialError} idleTimeoutMinutes={config.idleTimeoutMinutes} />
          <UsageToday initial={loadUsageToday(user.id)} />
        </>
      )}
    </PageMain>
  );
}
