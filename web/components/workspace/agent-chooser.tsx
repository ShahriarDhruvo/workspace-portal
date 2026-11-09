"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { AgentKind } from "@portal/db";
import { formatVersion } from "@/lib/format";
import type { AgentInfo } from "@/lib/gateway-types";
import { buttonClass } from "@/components/ui/button";
import { WarningIcon } from "@/components/ui/icons";
import { Tag } from "@/components/ui/tag";

// The choice of agent when nothing runs in the workspace, shaped like the page's other state cards: one
// selectable card per agent the install enables (name, version, one line about it) and a Start button. The
// cards are native radio buttons, so the keyboard works as usual: the selected card takes the focus first, the
// arrow keys move between agents, Enter starts. The workspace's last agent is marked and selected at first.

const CARD_CLASS =
  "flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3.5 py-3 " +
  "transition-[background-color,border-color,box-shadow] hover:bg-hover " +
  "has-checked:border-focus has-checked:bg-input " +
  "has-focus-visible:border-focus has-focus-visible:ring-3 has-focus-visible:ring-focus/50";

/** The radio: a 16px ring that fills with a primary dot when checked; the card draws its focus ring. */
const RADIO_CLASS =
  "mt-0.5 size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-line-strong bg-input " +
  "outline-none transition-colors checked:border-primary " +
  "checked:bg-[radial-gradient(circle,var(--color-primary)_0_3.5px,transparent_4px)]";

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
  const id = useId();
  const [selected, setSelected] = useState(initialAgent);
  const chosen = agents.find((agent) => agent.id === selected) ?? null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen) onStart(chosen.id);
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex w-[min(480px,100%)] flex-col gap-4 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-16 leading-snug font-medium">
          {warning ? <WarningIcon className="text-attention" /> : null}
          {title}
        </h2>
        <p role={warning ? "alert" : undefined} className="text-14 text-fg-muted">
          {children}
        </p>
      </div>
      {agents.length === 0 ? (
        <p className="text-14 text-fg-muted">No agent is enabled on this server. Ask the administrator.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div role="radiogroup" aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
            {agents.map((agent) => {
              const key = `${id}-${agent.id}`;
              return (
                <label key={agent.id} className={CARD_CLASS}>
                  <input
                    type="radio"
                    name="agent"
                    value={agent.id}
                    checked={selected === agent.id}
                    onChange={() => setSelected(agent.id)}
                    autoFocus={agent.id === initialAgent}
                    aria-labelledby={`${key}-name`}
                    aria-describedby={`${key}-meta ${key}-description`}
                    className={RADIO_CLASS}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span id={`${key}-name`} className="text-14 leading-5 font-medium text-fg">
                        {agent.name}
                      </span>
                      <span id={`${key}-meta`} className="contents">
                        {agent.id === lastAgent ? <Tag tone="outline">Last used</Tag> : null}
                        <span className="ml-auto font-mono text-12 text-fg-muted">{formatVersion(agent.version)}</span>
                      </span>
                    </span>
                    <span id={`${key}-description`} className="text-13 text-fg-muted">
                      {agent.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={!chosen} className={buttonClass("primary", "sm", "min-w-16")}>
              {chosen ? `Start ${chosen.name}` : "Start"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
