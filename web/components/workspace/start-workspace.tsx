"use client";

import { useState } from "react";
import { WORKSPACE_KIND_NAMES, type OnlineAccess, type WorkspaceKind } from "@portal/core/wire";
import { onlineBlockedReason } from "@/lib/workspace-kind";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { GlobeIcon, InfoIcon, LockIcon, PlayIcon } from "@/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Starting a stopped workspace, the same on Home, on the workspace page and in the admin's view: no workspace starts
// without the choice of kind, and one click on Start starts it (each kind's card says what the kind means). The
// caller lays the picker and the button out and holds the choice.

/**
 * The kind chosen for the next start: what the user picked, else `initialKind` (lib/workspace-kind.ts: Online
 * by default, the failed kind after a failed start), and Private whatever was picked while Online can't start
 * (`onlineBlocked` then says why).
 */
export function useKindChoice(online: OnlineAccess, initialKind: WorkspaceKind) {
  const [choice, setChoice] = useState<WorkspaceKind | null>(null);
  const onlineBlocked = onlineBlockedReason(online);
  const kind: WorkspaceKind = onlineBlocked ? "private" : (choice ?? initialKind);
  return { kind, choose: setChoice, onlineBlocked };
}

/** What each kind is, in a line under its name. */
const KIND_LINES: Readonly<Record<WorkspaceKind, string>> = {
  private: "No internet access. Web search and page reading still work.",
  online: "Public internet access, for installing packages and using online services.",
};

/** What each kind means for the files in it and for the agent's work: the tooltip of its card's info button (KindInfo). */
const KIND_DETAILS: Readonly<Record<WorkspaceKind, readonly string[]>> = {
  private: [
    "Starts without internet access: only the portal's web search and page reader reach the internet for it.",
    "Misbehaving software has far less room to do harm, but the agent can't download packages, use online services or test against them.",
  ],
  online: [
    "Starts with public internet access. Files uploaded to it or created in it could be exposed if any software in it is misconfigured or compromised.",
    "The Private workspace and its files stay separate.",
  ],
};

interface KindPickerProps {
  value: WorkspaceKind;
  onValueChange: (kind: WorkspaceKind) => void;
  /** Why Online can't be chosen (turned off on the portal, or not for this account); null when it can. */
  onlineBlocked: string | null;
  /** Unique on the page, for the radio ids. */
  idPrefix: string;
  /** The grid's columns (Home: side by side from `sm`; the workspace page's narrow card: stacked). */
  className?: string;
}

/**
 * The two kinds as radio cards, each with an info button in its bottom right corner, under the radio. With Online
 * unavailable its card is disabled and its line says why; its info button still answers.
 */
export function KindPicker({ value, onValueChange, onlineBlocked, idPrefix, className }: KindPickerProps) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => {
        if (next === "private" || (next === "online" && !onlineBlocked)) onValueChange(next);
      }}
      aria-label="Workspace to start"
      className={className}
    >
      {(["private", "online"] as const).map((kind) => {
        const Icon = kind === "online" ? GlobeIcon : LockIcon;
        const blocked = kind === "online" ? onlineBlocked : null;
        return (
          // The info button lies over the card, not in its label: a click on it never chooses the card, and its
          // name stays out of the radio's.
          <div key={kind} className="relative">
            <FieldLabel htmlFor={`${idPrefix}-${kind}`} className="h-full">
              <Field orientation="horizontal" data-disabled={blocked ? true : undefined}>
                <FieldContent>
                  <FieldTitle>
                    <Icon className="shrink-0" />
                    {WORKSPACE_KIND_NAMES[kind]}
                  </FieldTitle>
                  <FieldDescription className="text-13">{blocked ?? KIND_LINES[kind]}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={kind} id={`${idPrefix}-${kind}`} disabled={blocked !== null} />
              </Field>
            </FieldLabel>
            <KindInfo kind={kind} />
          </div>
        );
      })}
    </RadioGroup>
  );
}

/** A kind's details, from the info button of its card: on hover and focus, and on a tap, since a touch screen has no hover. */
function KindInfo({ kind }: { kind: WorkspaceKind }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        // The tooltip's own handlers close it on a press and on a click; a prevented event keeps them away.
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-1.25 bottom-1.25 text-muted-foreground"
          aria-label={`About the ${WORKSPACE_KIND_NAMES[kind]} workspace`}
        >
          <InfoIcon />
        </Button>
      </TooltipTrigger>
      {/* Below the card, whose own name and line stay readable beside it. */}
      <TooltipContent side="bottom" className="flex max-w-80 flex-col items-start gap-1">
        {KIND_DETAILS[kind].map((line) => (
          <p key={line}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

interface StartWorkspaceButtonProps {
  /** The chosen kind (useKindChoice). */
  kind: WorkspaceKind;
  /** After a failed start or a refusal: "Try again" instead of "Start Online" / "Start Private". */
  retry?: boolean;
  /** No harness is enabled: nothing can start. */
  disabled?: boolean;
  /** Starts that kind. The caller puts the start's progress in this button's place at once, so no second click starts again. */
  onStart: (kind: WorkspaceKind) => void;
}

/** The Start button, naming the chosen kind: one click starts it. */
export function StartWorkspaceButton({ kind, retry = false, disabled = false, onStart }: StartWorkspaceButtonProps) {
  return (
    <Button type="button" onClick={() => onStart(kind)} disabled={disabled}>
      <PlayIcon />
      {retry ? "Try again" : `Start ${WORKSPACE_KIND_NAMES[kind]}`}
    </Button>
  );
}
