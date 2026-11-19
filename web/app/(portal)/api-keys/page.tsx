import type { Metadata } from "next";
import { headers } from "next/headers";
import { loadApiKeys } from "@/lib/api-keys";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { gateway } from "@/lib/gateway";
import { requireUser } from "@/lib/session";
import { ApiKeys } from "@/components/api/api-keys";
import { Connect } from "@/components/api/connect";
import { PageHeading } from "@/components/layout/page-heading";
import { PageMain } from "@/components/layout/page-main";

export const metadata: Metadata = { title: "API" };

/** The signed-in user's own API keys, also for an administrator viewing someone else's workspace. */
export default async function ApiKeysPage() {
  const { user } = await requireUser();
  const [host, models] = await Promise.all([headers().then((all) => all.get("host")), gateway.models().catch(() => [])]);
  const view = loadApiKeys(getDb(), user.id);
  return (
    <PageMain width="md">
      <PageHeading title="API" />
      {/* The address the browser used: the portal is reached directly, or through a proxy that keeps Host. */}
      <Connect baseUrl={`${config.cookieSecure ? "https" : "http"}://${host}/llm/api/v1`} model={models[0] ?? null} examplesOpen={view.keys.length === 0} />
      <ApiKeys {...view} />
    </PageMain>
  );
}
