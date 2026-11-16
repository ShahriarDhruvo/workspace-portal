"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import type { AgentKind } from "@portal/db";
import { restartWorkspace, saveHarness } from "@/lib/actions/settings";
import { formatVersion } from "@/lib/format";
import type { AgentInfo, WorkspaceInfo } from "@/lib/gateway-types";
import { stopNeedsConfirm, stopWarnings } from "@/lib/workspace-stop";
import { FormError } from "@/components/forms/form-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { StopDialog } from "@/components/workspace/stop-dialog";

interface HarnessPickerProps {
  agents: AgentInfo[];
  /** The harness the workspace starts with now: the saved choice, or the first enabled agent. */
  chosen: AgentKind;
  /** The running (or starting) workspace, to tell when it runs another harness; null when stopped or unknown. */
  running: Pick<WorkspaceInfo, "agent" | "busy" | "connections"> | null;
  agentNames: Readonly<Record<AgentKind, string>>;
}

/**
 * Settings' harness choice: a radio card per enabled agent, saved as soon as it changes. A running workspace
 * keeps its harness until it starts again; the card says so and offers "Restart now".
 */
export function HarnessPicker({ agents, chosen, running, agentNames }: HarnessPickerProps) {
  const [value, setValue] = useOptimistic(chosen);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [restarting, startRestart] = useTransition();
  const [restarted, setRestarted] = useState<AgentKind | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const restartButton = useRef<HTMLButtonElement>(null);

  function choose(next: string) {
    const agent = agents.find((offered) => offered.id === next)?.id;
    if (!agent) return;
    setError(null);
    setRestarted(null);
    startSaving(async () => {
      setValue(agent);
      const result = await saveHarness(agent);
      if (!result.ok) setError(result.message);
    });
  }

  async function restart(): Promise<string | null> {
    const result = await restartWorkspace();
    if (!result.ok) return result.message;
    setRestarted(value);
    return null;
  }

  function onRestart() {
    if (running && stopNeedsConfirm(stopWarnings(running, false))) {
      setConfirmOpen(true);
      return;
    }
    startRestart(async () => {
      const problem = await restart();
      if (problem) setError(problem);
    });
  }

  const differs = running?.agent != null && running.agent !== value;
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup value={value} onValueChange={choose} aria-label="Harness" aria-busy={saving || undefined} disabled={restarting}>
        {agents.map((agent) => (
          <FieldLabel key={agent.id} htmlFor={`harness-${agent.id}`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>
                  {agent.name}
                  <span className="font-mono text-12 font-normal text-muted-foreground">{formatVersion(agent.version)}</span>
                </FieldTitle>
                <FieldDescription>{agent.description}</FieldDescription>
              </FieldContent>
              <RadioGroupItem value={agent.id} id={`harness-${agent.id}`} />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
      {error ? <FormError>{error}</FormError> : null}
      {differs && running?.agent ? (
        <Alert role="status">
          <AlertTitle>Your workspace is running {agentNames[running.agent]}.</AlertTitle>
          <AlertDescription>{agentNames[value]} starts next time.</AlertDescription>
          <div className="mt-2">
            <Button
              ref={restartButton}
              type="button"
              size="sm"
              variant="outline"
              onClick={onRestart}
              disabled={restarting || saving}
              aria-busy={restarting || undefined}
            >
              {restarting ? <Spinner aria-hidden="true" /> : <RefreshIcon />}
              {restarting ? "Restarting…" : "Restart now"}
            </Button>
          </div>
        </Alert>
      ) : restarted ? (
        <p role="status" className="flex items-center gap-1.5 text-13 text-success">
          <CheckIcon className="shrink-0" />
          Your workspace restarted with {agentNames[restarted]}.
        </p>
      ) : null}
      {running ? (
        <StopDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          kind="restart"
          warnings={stopWarnings(running, false)}
          onConfirm={restart}
          returnFocusTo={restartButton}
        />
      ) : null}
    </div>
  );
}
