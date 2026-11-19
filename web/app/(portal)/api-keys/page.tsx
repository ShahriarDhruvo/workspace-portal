import type { Metadata } from "next";
import { headers } from "next/headers";
import { loadApiKeys } from "@/lib/api-keys";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { ApiKeys } from "@/components/api/api-keys";
import { CopyButton } from "@/components/common/secret-value";
import { PageHeading } from "@/components/layout/page-heading";
import { PageMain } from "@/components/layout/page-main";
import { Section } from "@/components/layout/section";
import { CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "API" };

/** The signed-in user's own API keys, also for an administrator viewing someone else's workspace. */
export default async function ApiKeysPage() {
  const { user } = await requireUser();
  // The address the browser used: the portal is reached directly, or through a proxy that keeps Host.
  const baseUrl = `${config.cookieSecure ? "https" : "http"}://${(await headers()).get("host")}/llm/api/v1`;
  const example = `curl ${baseUrl}/models -H "Authorization: Bearer $KEY"`;
  return (
    <PageMain width="lg">
      <PageHeading title="API" />
      <div className="flex flex-col gap-6">
        <Section id="connect" title="Connect your software" description="An editor, a script: anything that speaks the OpenAI API can use the portal's LLM with one of your keys.">
          <CardContent className="flex flex-col gap-3">
            <Copyable label="Base URL" value={baseUrl} />
            <Copyable label="Try it: the models it serves" value={example} />
          </CardContent>
        </Section>
        <ApiKeys {...loadApiKeys(getDb(), user.id)} />
      </div>
    </PageMain>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-12 text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 basis-64 rounded-md bg-muted px-3 py-2 font-mono text-12 wrap-break-word">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
