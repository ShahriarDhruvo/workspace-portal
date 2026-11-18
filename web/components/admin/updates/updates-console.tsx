"use client";

import { AGENT_NAMES, type AgentVersionsOverview, type EngineOverview } from "@portal/core/wire";
import type { ActionContext } from "@/lib/agent-versions";
import type { Loaded } from "@/lib/update-jobs";
import { PageHeading } from "@/components/layout/page-heading";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { RefreshIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { AgentCard } from "./agent-card";
import { JobAnnouncer } from "./agent-job";
import { EngineCard } from "./engine-card";
import { usePolled } from "./use-polled";
import { UnreachableAlert, VersionCard } from "./version-card";

interface UpdatesConsoleProps {
  initialAgents: Loaded<AgentVersionsOverview>;
  initialEngine: Loaded<EngineOverview>;
}

/**
 * The Updates page: one card each for the LLM engine and the enabled agents. Each part polls its own route; "Check
 * for updates" asks the registries again for both.
 */
export function UpdatesConsole({ initialAgents, initialEngine }: UpdatesConsoleProps) {
  const agents = usePolled(initialAgents, "/api/admin/agents");
  const engine = usePolled(initialEngine, "/api/admin/engine");
  const versions = agents.data.data;
  const job = versions?.job ?? null;
  const context: ActionContext = { job, offline: agents.data.error !== null };
  const checked = [versions?.checkedAt, engine.data.data?.releases?.checkedAt].filter((at): at is number => typeof at === "number");

  return (
    <>
      <PageHeading
        title="Updates"
        actions={
          <RegistryCheck
            checkedAt={checked.length > 0 ? Math.min(...checked) : null}
            checking={agents.refreshing || engine.refreshing}
            onCheck={() => void Promise.all([agents.refresh(), engine.refresh()])}
          />
        }
      />
      <JobAnnouncer job={job} name={job ? AGENT_NAMES[job.agent] : ""} />
      <div className="flex flex-col gap-4">
        <EngineCard data={engine.data} onChanged={engine.pollNow} />
        {versions ? (
          versions.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              context={context}
              registry={{ error: versions.registryError, checkedAt: versions.checkedAt }}
              onChanged={agents.pollNow}
            />
          ))
        ) : (
          <VersionCard title="Agents" status={{ label: "Can't reach", variant: "destructive", pending: false }}>
            <UnreachableAlert
              title="The workspace service can't be reached"
              message={agents.data.error?.message ?? null}
              onRetry={agents.pollNow}
            >
              Agent versions can&apos;t be shown until it answers.
            </UnreachableAlert>
          </VersionCard>
        )}
      </div>
    </>
  );
}

/**
 * Check for updates asks the npm registry, the image registry and GitHub again. On a phone the button stays beside
 * the title and the time goes under them.
 */
function RegistryCheck({ checkedAt, checking, onCheck }: { checkedAt: number | null; checking: boolean; onCheck: () => void }) {
  return (
    <>
      <span className="text-12 text-muted-foreground max-sm:order-last max-sm:basis-full sm:mr-1">
        {checkedAt ? (
          <>
            Checked <LocalTime at={checkedAt} relative />
          </>
        ) : (
          "Not checked yet"
        )}
      </span>
      {/* Not disabled while checking, so the focus stays on it; a second press just waits for the first. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-busy={checking || undefined}
        data-pending={checking ? "" : undefined}
        onClick={() => {
          if (!checking) onCheck();
        }}
      >
        {checking ? <Spinner aria-hidden="true" /> : <RefreshIcon />}
        Check for updates
      </Button>
    </>
  );
}
