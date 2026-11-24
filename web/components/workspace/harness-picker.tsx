"use client";

import { useId, useOptimistic, useState, useTransition } from "react";
import type { AgentInfo, AgentKind } from "@portal/core/wire";
import { formatVersion } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/validation";
import { Field, FieldContent, FieldLabel, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// The harness whose workspace a Start launches (users.agent), chosen where the workspace is started: on Home for
// one's own, and on a user's page for an administrator's change of anyone's. It is saved as soon as it changes.

/**
 * A harness choice that saves itself. `value` is the harness just picked while `save` runs and the stored one
 * (`saved`) otherwise, so a refused save shows what is stored again, with `error` saying why.
 */
export function useHarnessChoice<Saved extends AgentKind | null>(saved: Saved, save: (agent: AgentKind) => Promise<ActionResult>) {
  const [value, setValue] = useOptimistic<Saved | AgentKind>(saved);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function choose(agent: AgentKind) {
    setError(null);
    startSaving(async () => {
      setValue(agent);
      const result = await save(agent);
      if (!result.ok) setError(result.message);
    });
  }

  return { value, saving, error, choose };
}

interface HarnessPickerProps {
  /** The agents this install enables, in display order. */
  agents: AgentInfo[];
  value: AgentKind;
  onValueChange: (agent: AgentKind) => void;
  /** The choice is being saved. */
  saving?: boolean;
  /** The id of the heading that names the group; without one it is named "Harness". */
  labelledBy?: string;
}

/**
 * A radio card per enabled agent, with its name and version, and under them what the choice changes: the workspace.
 * On wider screens the cards sit side by side: two in a row, or three with the version under the name once there are
 * more than two. Three share the row equally unless a name needs more than its third (Home's card is narrow), which
 * it then gets: a name stays on one line.
 */
export function HarnessPicker({ agents, value, onValueChange, saving = false, labelledBy }: HarnessPickerProps) {
  const threeAcross = agents.length > 2;
  const noteId = useId();
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          const agent = agents.find((offered) => offered.id === next)?.id;
          if (agent) onValueChange(agent);
        }}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : "Harness"}
        aria-describedby={noteId}
        aria-busy={saving || undefined}
        className={threeAcross ? "sm:grid-cols-[repeat(3,minmax(min-content,1fr))]" : "sm:grid-cols-2"}
      >
        {agents.map((agent) => (
          <FieldLabel key={agent.id} htmlFor={`harness-${agent.id}`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle className={cn("flex-wrap gap-x-2 gap-y-0", threeAcross && "sm:flex-col sm:items-start")}>
                  <span className="whitespace-nowrap">{agent.name}</span>
                  <span className="font-mono text-12 font-normal text-muted-foreground">{formatVersion(agent.version)}</span>
                </FieldTitle>
              </FieldContent>
              <RadioGroupItem value={agent.id} id={`harness-${agent.id}`} />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
      <p id={noteId} className="text-13 text-muted-foreground">
        Each harness has its own workspace: files and chats are not shared between them.
      </p>
    </div>
  );
}
