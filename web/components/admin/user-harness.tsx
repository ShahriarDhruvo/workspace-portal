"use client";

import { useRef, useState } from "react";
import { AGENT_NAMES, type AgentInfo, type AgentKind, type WorkspaceInfo } from "@portal/core/wire";
import { restartUserWorkspace, setUserHarness } from "@/lib/actions/admin";
import { stopWarnings } from "@/lib/workspace-stop";
import { FormError } from "@/components/forms/form-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { HarnessPicker, useHarnessChoice } from "@/components/workspace/harness-picker";
import { StopDialog } from "@/components/workspace/stop-dialog";

interface UserHarnessProps {
  agents: AgentInfo[];
  /** The harness the user's workspace starts with now: the saved choice, or the first enabled agent. */
  chosen: AgentKind;
  /** The user's running (or starting) workspace, to tell when it runs another harness; null when stopped or unknown. */
  running: Pick<WorkspaceInfo, "agent" | "busy" | "connections"> | null;
  /** The id of the card's heading, which names the choice. */
  labelledBy: string;
  owner: { id: number; name: string };
}

/**
 * The harness choice of a user's page, for an administrator (people choose their own on Home). A running workspace
 * keeps its harness until it starts again; the card says so and offers "Restart now", which confirms first (the
 * restart runs in the dialog).
 */
export function UserHarness({ agents, chosen, running, labelledBy, owner }: UserHarnessProps) {
  const harness = useHarnessChoice(chosen, (agent) => setUserHarness(owner.id, agent));
  const [restarted, setRestarted] = useState<AgentKind | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const restartButton = useRef<HTMLButtonElement>(null);

  async function restart() {
    const result = await restartUserWorkspace(owner.id);
    if (result.ok) setRestarted(harness.value);
    return result;
  }

  const differs = running?.agent != null && running.agent !== harness.value;
  return (
    <div className="flex flex-col gap-4">
      <HarnessPicker
        agents={agents}
        value={harness.value}
        onValueChange={(agent) => {
          setRestarted(null);
          harness.choose(agent);
        }}
        saving={harness.saving}
        labelledBy={labelledBy}
      />
      {harness.error ? <FormError>{harness.error}</FormError> : null}
      {differs && running?.agent ? (
        <Alert role="status">
          <AlertTitle>
            {owner.name}&apos;s workspace is running {AGENT_NAMES[running.agent]}.
          </AlertTitle>
          <AlertDescription>{AGENT_NAMES[harness.value]} starts next time.</AlertDescription>
          <div className="mt-2">
            <Button
              ref={restartButton}
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              disabled={harness.saving}
            >
              <RefreshIcon />
              Restart now
            </Button>
          </div>
        </Alert>
      ) : restarted ? (
        <p role="status" className="flex items-center gap-1.5 text-13 text-success">
          <CheckIcon className="shrink-0" />
          {owner.name}&apos;s workspace restarted with {AGENT_NAMES[restarted]}.
        </p>
      ) : null}
      {running ? (
        <StopDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          kind="restart"
          owner={owner.name}
          warnings={stopWarnings(running, false)}
          onConfirm={restart}
          returnFocusTo={restartButton}
        />
      ) : null}
    </div>
  );
}
