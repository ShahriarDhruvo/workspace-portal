"use client";

import { useRef, useState, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import { WORKSPACE_KIND_NAMES, type OnlineAccess, type WorkspaceKind } from "@portal/core/wire";
import { returnFocus } from "@/lib/focus";
import { onlineBlockedReason, otherKind } from "@/lib/workspace-kind";
import { SubmitButton } from "@/components/forms/submit-button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { GlobeIcon, LockIcon, PlayIcon } from "@/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// Starting a stopped workspace, the same on Home, on the workspace page and in the admin's view: no workspace starts
// without the choice of kind and the confirmation. The caller lays the picker and the button out and holds the choice.

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

/** The user's two workspaces as radio cards. With Online unavailable its card is disabled and its line says why. */
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
          <FieldLabel key={kind} htmlFor={`${idPrefix}-${kind}`}>
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
        );
      })}
    </RadioGroup>
  );
}

interface StartWorkspaceButtonProps {
  /** The chosen kind (useKindChoice). */
  kind: WorkspaceKind;
  /** Picks the other kind, offered as "Use Private" / "Use Online" in the confirmation; absent when it can't start. */
  onSwitch?: () => void;
  /** "your", or the owner's name with "'s" when an administrator starts someone else's. */
  whose: string;
  /** After a failed start or a refusal: "Try again" instead of "Start Online" / "Start Private". */
  retry?: boolean;
  /** No harness is enabled: nothing can start. */
  disabled?: boolean;
  /** Starts that kind; resolves once the request is answered (the caller shows what came of it). */
  onStart: (kind: WorkspaceKind) => Promise<void>;
}

/** The Start button, naming the chosen kind, and the confirmation it opens. */
export function StartWorkspaceButton({ kind, onSwitch, whose, retry = false, disabled = false, onStart }: StartWorkspaceButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={startButton} type="button" onClick={() => setConfirming(true)} disabled={disabled}>
        <PlayIcon />
        {retry ? "Try again" : `Start ${WORKSPACE_KIND_NAMES[kind]}`}
      </Button>
      <StartDialog
        open={confirming}
        onOpenChange={setConfirming}
        kind={kind}
        onSwitch={onSwitch}
        whose={whose}
        onConfirm={() => onStart(kind)}
        returnFocusTo={startButton}
      />
    </>
  );
}

interface StartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: WorkspaceKind;
  /** Picks the other kind, and so flips the dialog to it; absent when that one can't start. */
  onSwitch?: () => void;
  whose: string;
  onConfirm: () => Promise<void>;
  returnFocusTo: RefObject<HTMLElement | null>;
}

/** What each kind means for the files in it, in the words of the confirmation. */
function KindWarning({ kind }: { kind: WorkspaceKind }) {
  return kind === "online" ? (
    <>
      <p>
        It starts with <strong className="font-medium text-foreground">public internet access</strong>. Files uploaded to
        it or created in it could be exposed if any software in it is misconfigured or compromised.
      </p>
      <p>The Private workspace and its files stay separate.</p>
    </>
  ) : (
    <>
      <p>
        It starts <strong className="font-medium text-foreground">without internet access</strong>: only the
        portal&apos;s web search and page reader reach the internet for it.
      </p>
      <p>
        Misbehaving software has far less room to do harm, but the agent can&apos;t download packages, use online
        services or test against them.
      </p>
    </>
  );
}

/**
 * Confirms a start: what the chosen kind means, the swap to the other kind (it keeps its place, and so the focus, as
 * the dialog flips) and Start. It stays open while the start request runs and closes then.
 */
function StartDialog({ open, onOpenChange, kind, onSwitch, whose, onConfirm, returnFocusTo }: StartDialogProps) {
  const Icon = kind === "online" ? GlobeIcon : LockIcon;
  const other = otherKind(kind);
  async function confirm() {
    await onConfirm();
    onOpenChange(false);
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <form action={confirm} className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Start {whose} {WORKSPACE_KIND_NAMES[kind]} workspace?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <KindWarning kind={kind} />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <FooterButtons kind={kind} other={other} onSwitch={onSwitch} />
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Cancel, the swap and the start; while the start runs, only the spinner of the start button moves. */
function FooterButtons({ kind, other, onSwitch }: { kind: WorkspaceKind; other: WorkspaceKind; onSwitch?: () => void }) {
  const { pending } = useFormStatus();
  const OtherIcon = other === "online" ? GlobeIcon : LockIcon;
  return (
    <>
      <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
      {onSwitch ? (
        <Button type="button" variant="outline" disabled={pending} onClick={onSwitch}>
          <OtherIcon />
          Use {WORKSPACE_KIND_NAMES[other]}
        </Button>
      ) : null}
      <SubmitButton icon={<PlayIcon />} pendingLabel="Starting…">
        Start {WORKSPACE_KIND_NAMES[kind]}
      </SubmitButton>
    </>
  );
}
