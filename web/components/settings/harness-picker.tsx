"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { AGENT_NAMES, type AgentInfo, type AgentKind, type WorkspaceInfo } from "@portal/core/wire";
import { restartWorkspace, saveHarness } from "@/lib/actions/settings";
import { formatVersion } from "@/lib/format";
import { stopWarnings } from "@/lib/workspace-stop";
import { FormError } from "@/components/forms/form-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldLabel, FieldTitle } from "@/components/ui/field";
import { CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { StopDialog } from "@/components/workspace/stop-dialog";

interface HarnessPickerProps {
  agents: AgentInfo[];
  /** The harness the workspace starts with now: the saved choice, or the first enabled agent. */
  chosen: AgentKind;
  /** The running (or starting) workspace, to tell when it runs another harness; null when stopped or unknown. */
  running: Pick<WorkspaceInfo, "agent" | "busy" | "connections"> | null;
  labelledBy: string;
}

/**
 * Settings' harness choice: a radio card per enabled agent (its name and version, side by side on wider screens),
 * saved as soon as it changes. A running workspace keeps its harness until it starts again; the card says so and
 * offers "Restart now", which confirms first (the restart runs in the dialog).
 */
export function HarnessPicker({ agents, chosen, running, labelledBy }: HarnessPickerProps) {
  const [value, setValue] = useOptimistic(chosen);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
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

  const differs = running?.agent != null && running.agent !== value;
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        value={value}
        onValueChange={choose}
        aria-labelledby={labelledBy}
        aria-busy={saving || undefined}
        className="sm:grid-cols-2"
      >
        {agents.map((agent) => (
          <FieldLabel key={agent.id} htmlFor={`harness-${agent.id}`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle className="flex-wrap gap-x-2 gap-y-0">
                  {agent.name}
                  <span className="font-mono text-12 font-normal text-muted-foreground">{formatVersion(agent.version)}</span>
                </FieldTitle>
              </FieldContent>
              <RadioGroupItem value={agent.id} id={`harness-${agent.id}`} />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
      {error ? <FormError>{error}</FormError> : null}
      {differs && running?.agent ? (
        <Alert role="status">
          <AlertTitle>Your workspace is running {AGENT_NAMES[running.agent]}.</AlertTitle>
          <AlertDescription>{AGENT_NAMES[value]} starts next time.</AlertDescription>
          <div className="mt-2">
            <Button
              ref={restartButton}
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              disabled={saving}
            >
              <RefreshIcon />
              Restart now
            </Button>
          </div>
        </Alert>
      ) : restarted ? (
        <p role="status" className="flex items-center gap-1.5 text-13 text-success">
          <CheckIcon className="shrink-0" />
          Your workspace restarted with {AGENT_NAMES[restarted]}.
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
