import type { Metadata } from "next";
import Link from "next/link";
import { AGENT_NAMES, displayName } from "@portal/db";
import { openMyWorkspace } from "@/lib/actions/admin";
import { startingAgent } from "@/lib/agent-choice";
import { config } from "@/lib/config";
import { initials } from "@/lib/format";
import { gateway, toApiError } from "@/lib/gateway";
import type { WorkspaceStatusResponse } from "@/lib/gateway-types";
import { requireUser } from "@/lib/session";
import { loadUsageToday } from "@/lib/usage";
import { SubmitButton } from "@/components/forms/submit-button";
import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { HomeCard } from "@/components/workspace/home-card";
import { UsageToday } from "@/components/workspace/usage-today";
import { ViewingBanner } from "@/components/workspace/viewing-banner";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const session = await requireUser();
  const { user, target, actingAs } = session;
  const viewer = { name: displayName(user), initials: initials(user.firstName, user.lastName), isAdmin: user.role === "admin" };

  let initial: WorkspaceStatusResponse | null = null;
  let initialError: string | null = null;
  if (!actingAs) {
    try {
      const [info, agents] = await Promise.all([gateway.getWorkspace(user.id), gateway.agents()]);
      initial = { ...info, targetUserId: user.id, actingAs: false, agents, nextAgent: startingAgent(user.agent, agents) };
    } catch (error) {
      initialError = toApiError(error).message;
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {actingAs ? (
        <ViewingBanner returnHref="/workspace">You are viewing {displayName(target)}&apos;s workspace</ViewingBanner>
      ) : null}
      <AppHeader viewer={viewer} />
      <main className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-4 py-10 max-sm:py-6">
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
            <HomeCard initial={initial} initialError={initialError} idleTimeoutMinutes={config.idleTimeoutMinutes} agentNames={AGENT_NAMES} />
            <UsageToday usage={loadUsageToday(user.id)} />
          </>
        )}
      </main>
    </div>
  );
}
