"use client";

import { useRef, useState, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import type { WorkspaceKind } from "@portal/db";
import { returnFocus } from "@/lib/focus";
import type { OnlineAccess } from "@/lib/gateway-types";
import { KIND_NAMES, onlineBlockedReason, otherKind } from "@/lib/workspace-kind";
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
import { GlobeIcon, LockIcon, PlayIcon } from "@/components/ui/icons";
import { KindSwitch } from "./kind-switch";

// Starting a stopped workspace, the same on Home, on the workspace page and in the admin's view of someone's
// workspace: the Private | Online switch, Start, and the confirmation that says what the chosen kind means. No
// workspace starts without that choice and that confirmation.

interface StartWorkspaceProps {
  /** Whether Online may start for this workspace's owner (WorkspaceInfo.online). */
  online: OnlineAccess;
  /** The kind the switch starts on (initialKind in lib/workspace-kind.ts). */
  initialKind: WorkspaceKind;
  /** "your", or the owner's name with "'s" when an administrator starts someone else's. */
  whose: string;
  /** The Start button's label: "Start", "Start again", "Try again". */
  label: string;
  /** No harness is enabled: nothing can start. */
  disabled?: boolean;
  /** Starts that kind; resolves once the request is answered (the caller shows what came of it). */
  onStart: (kind: WorkspaceKind) => Promise<void>;
  /** For the switch's ToggleGroup (e.g. stretching its items on a phone). */
  switchClassName?: string;
}

/**
 * The switch and the Start button, as siblings for the caller's button row, and the confirmation Start opens.
 * Online unavailable, the switch stays on Private and Start confirms Private.
 */
export function StartWorkspace({ online, initialKind, whose, label, disabled = false, onStart, switchClassName }: StartWorkspaceProps) {
  const [choice, setChoice] = useState(initialKind);
  const [confirming, setConfirming] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const onlineBlocked = onlineBlockedReason(online);
  const kind = onlineBlocked ? "private" : choice;
  return (
    <>
      <KindSwitch value={kind} onValueChange={setChoice} onlineBlocked={onlineBlocked} className={switchClassName} />
      <Button ref={startButton} type="button" onClick={() => setConfirming(true)} disabled={disabled}>
        <PlayIcon />
        {label}
      </Button>
      <StartDialog
        open={confirming}
        onOpenChange={setConfirming}
        kind={kind}
        onSwitch={onlineBlocked ? undefined : () => setChoice(otherKind(kind))}
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
  /** Flips the switch, and so the dialog, to the other kind; absent when that one can't start. */
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
 * The confirmation of a start, in the user's own sketch: what the chosen kind means, "Use Private" / "Use Online"
 * to flip to the other kind (it doesn't start anything), and "Start Online" / "Start Private". The swap button
 * keeps its place, and so the focus, as the dialog flips. It stays open while the start request runs (its Start
 * button says "Starting…", the others wait: the caller's own state changes only show once the request is
 * answered) and closes then; the page shows what came of it.
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
              Start {whose} {KIND_NAMES[kind]} workspace?
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
          Use {KIND_NAMES[other]}
        </Button>
      ) : null}
      <SubmitButton icon={<PlayIcon />} pendingLabel="Starting…">
        Start {KIND_NAMES[kind]}
      </SubmitButton>
    </>
  );
}
