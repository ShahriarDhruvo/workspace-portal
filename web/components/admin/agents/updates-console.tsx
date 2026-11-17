"use client";

import type { AgentKind } from "@portal/core";
import type { ActionContext } from "@/lib/agent-versions";
import type { AdminAgents, AdminEngine } from "@/lib/overview";
import { EngineCard } from "@/components/admin/engine/engine-card";
import { useEngine } from "@/components/admin/engine/use-engine";
import { PageHeading } from "@/components/layout/page-heading";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { RefreshIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { AgentCard } from "./agent-card";
import { JobAnnouncer } from "./agent-job";
import { useAgentVersions } from "./use-agent-versions";
import { UnreachableAlert, VersionCard } from "./version-card";

interface UpdatesConsoleProps {
  initialAgents: AdminAgents;
  initialEngine: AdminEngine;
  /** AGENT_NAMES, which this client component can't import from @portal/core. */
  agentNames: Readonly<Record<AgentKind, string>>;
}

/**
 * The Updates page: one card each for the LLM engine (on the LLM server) and the enabled agents (images on this
 * server), all in the same layout (VersionCard, PackageImages), each with its running or last job inline. Live: each
 * part polls its own route, every second while its job runs; "Check for updates" asks the registries again for both.
 */
export function UpdatesConsole({ initialAgents, initialEngine, agentNames }: UpdatesConsoleProps) {
  const agents = useAgentVersions(initialAgents);
  const engine = useEngine(initialEngine);
  const versions = agents.data.versions;
  const job = versions?.job ?? null;
  const context: ActionContext = { job, offline: agents.data.error !== null };
  const checked = [versions?.checkedAt, engine.data.engine?.releases?.checkedAt].filter((at): at is number => typeof at === "number");

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
      <JobAnnouncer job={job} name={job ? agentNames[job.agent] : ""} />
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
          <VersionCard title="Agents" status={{ label: "Can't reach", variant: "destructive" }}>
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

/** "Checked 5 min ago" and the button that asks the npm registry, the image registry and GitHub again. */
function RegistryCheck({ checkedAt, checking, onCheck }: { checkedAt: number | null; checking: boolean; onCheck: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-12 text-muted-foreground">
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
    </div>
  );
}
