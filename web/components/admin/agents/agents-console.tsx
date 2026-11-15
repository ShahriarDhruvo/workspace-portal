"use client";

import { useRef } from "react";
import type { AgentKind } from "@portal/db";
import { isJobActive, type ActionContext } from "@/lib/agent-versions";
import type { AdminAgents } from "@/lib/gateway-types";
import { PageHeading } from "@/components/layout/page-heading";
import { LocalTime } from "@/components/local-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RefreshIcon, WarningIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { ServiceIssue } from "../service-issue";
import { AgentCard } from "./agent-card";
import { JobAnnouncer, UpdateJobPanel } from "./update-job-panel";
import { useAgentVersions } from "./use-agent-versions";
import { useDismissedJob } from "./use-dismissed-job";

interface AgentsConsoleProps {
  initial: AdminAgents;
  /** AGENT_NAMES, which this client component can't import from @portal/db. */
  agentNames: Readonly<Record<AgentKind, string>>;
}

/**
 * The Agents page: a card per enabled agent with its versions and images, and the update job (one at a time, for
 * all agents) above them while it runs and once it has finished. Live through useAgentVersions.
 */
export function AgentsConsole({ initial, agentNames }: AgentsConsoleProps) {
  const { versions, error, checking, pollNow, checkForUpdates } = useAgentVersions(initial);
  const [dismissedJob, dismissJob] = useDismissedJob();
  /** Takes the focus from a dismissed outcome's Dismiss button, which goes with it. */
  const heading = useRef<HTMLHeadingElement>(null);
  const job = versions?.job ?? null;
  const context: ActionContext = { job, offline: error !== null };
  const shownJob = job && (isJobActive(job) || (dismissedJob !== undefined && dismissedJob !== job.id)) ? job : null;

  return (
    <>
      <PageHeading
        title="Agents"
        headingRef={heading}
        actions={versions ? <RegistryCheck checkedAt={versions.checkedAt} checking={checking} onCheck={checkForUpdates} /> : null}
      >
        Updates build a new image on this server; switching back to an image that is still here takes seconds. Running
        workspaces keep their version until they restart.
      </PageHeading>
      {error ? (
        <ServiceIssue message={error.message}>
          {versions ? "The versions shown may be out of date." : "Agent versions can't be shown until it answers."}
        </ServiceIssue>
      ) : null}
      {versions?.registryError ? <RegistryProblem message={versions.registryError} checkedAt={versions.checkedAt} /> : null}
      <JobAnnouncer job={job} name={job ? agentNames[job.agent] : ""} />
      {shownJob ? (
        <UpdateJobPanel
          key={shownJob.id}
          job={shownJob}
          name={agentNames[shownJob.agent]}
          agent={versions?.agents.find((agent) => agent.id === shownJob.agent) ?? null}
          onChanged={pollNow}
          onDismiss={() => {
            heading.current?.focus();
            dismissJob(shownJob.id);
          }}
        />
      ) : null}
      {versions ? (
        <div className="flex flex-col gap-4">
          {versions.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} context={context} onChanged={pollNow} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** "Checked 5 min ago" and the button that asks the npm registry again. */
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

/** The npm registry didn't answer: what is shown about releases may be stale, and updates may fail until it does. */
function RegistryProblem({ message, checkedAt }: { message: string; checkedAt: number | null }) {
  return (
    <Alert variant="warning" role="status">
      <WarningIcon />
      <AlertTitle className="line-clamp-none">The npm registry can&apos;t be reached</AlertTitle>
      <AlertDescription>
        <p>
          {message}{" "}
          {checkedAt ? (
            <>
              Latest versions and release channels are as of <LocalTime at={checkedAt} relative />.
            </>
          ) : (
            "Latest versions and release channels are unknown."
          )}{" "}
          Updates that build an image check the registry too, so they may fail until it answers; switching to an image
          on this server doesn&apos;t need it.
        </p>
      </AlertDescription>
    </Alert>
  );
}
