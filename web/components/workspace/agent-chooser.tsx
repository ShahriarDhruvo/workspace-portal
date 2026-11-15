"use client";

import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { AgentKind } from "@portal/db";
import { formatVersion } from "@/lib/format";
import type { AgentInfo } from "@/lib/gateway-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { WarningIcon } from "@/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// The choice of agent when nothing runs in the workspace, shaped like the page's other state cards: one
// choice card per agent the install enables (name, version, one line about it) and a Start button. The cards
// form a radio group, so the keyboard works as for native radios: the selected card takes the focus first,
// the arrow keys move between agents, Enter starts. The workspace's last agent is marked and selected at first.

interface AgentChooserProps {
  title: string;
  /** What the person should know first (why it stopped, why the start failed). */
  children: ReactNode;
  warning?: boolean;
  agents: AgentInfo[];
  /** The workspace's last agent, marked "Last used". */
  lastAgent: AgentKind | null;
  /** The agent selected at first. */
  initialAgent: AgentKind | null;
  onStart: (agent: AgentKind) => void;
}

export function AgentChooser({ title, children, warning = false, agents, lastAgent, initialAgent, onStart }: AgentChooserProps) {
  const titleId = useId();
  const [selected, setSelected] = useState(initialAgent);
  const chosen = agents.find((agent) => agent.id === selected) ?? null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen) onStart(chosen.id);
  }

  return (
    <Card role="region" aria-labelledby={titleId} className="w-[min(480px,100%)]">
      <CardHeader>
        <CardTitle asChild className="flex items-center gap-2">
          <h2 id={titleId}>
            {warning ? <WarningIcon className="text-attention" /> : null}
            {title}
          </h2>
        </CardTitle>
        <CardDescription role={warning ? "alert" : undefined}>{children}</CardDescription>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <p className="text-14 text-muted-foreground">No agent is enabled on this server. Ask the administrator.</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <RadioGroup
              value={selected ?? ""}
              onValueChange={(value) => setSelected(value as AgentKind)}
              aria-labelledby={titleId}
              className="gap-2"
            >
              {agents.map((agent) => (
                <AgentOption
                  key={agent.id}
                  agent={agent}
                  lastUsed={agent.id === lastAgent}
                  autoFocus={agent.id === initialAgent}
                />
              ))}
            </RadioGroup>
            <div className="flex justify-end">
              <Button type="submit" size="sm" className="min-w-16" disabled={!chosen}>
                {chosen ? `Start ${chosen.name}` : "Start"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** Radix radios are buttons, which ignore Enter; inside the chooser it submits, as a native radio would. */
function submitOnEnter(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter") event.currentTarget.form?.requestSubmit();
}

/** One agent as a choice card: the radio, its name, "Last used", the version and what it is. */
function AgentOption({ agent, lastUsed, autoFocus }: { agent: AgentInfo; lastUsed: boolean; autoFocus: boolean }) {
  const id = useId();
  return (
    <FieldLabel htmlFor={`${id}-radio`}>
      <Field orientation="horizontal">
        <RadioGroupItem
          id={`${id}-radio`}
          value={agent.id}
          autoFocus={autoFocus}
          aria-labelledby={`${id}-name`}
          aria-describedby={`${id}-meta ${id}-description`}
          onKeyDown={submitOnEnter}
        />
        <FieldContent className="min-w-0 gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <FieldTitle id={`${id}-name`}>{agent.name}</FieldTitle>
            <span id={`${id}-meta`} className="contents">
              {lastUsed ? <Badge variant="outline">Last used</Badge> : null}
              <span className="ml-auto font-mono text-12 text-muted-foreground">{formatVersion(agent.version)}</span>
            </span>
          </div>
          <FieldDescription id={`${id}-description`} className="text-13 text-muted-foreground">
            {agent.description}
          </FieldDescription>
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}
