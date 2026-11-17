"use client";

import { useActionState, useEffect, useEffectEvent, type ReactNode, type RefObject } from "react";
import { removeAgentImage, updateAgent, type AgentActionState } from "@/lib/actions/agents";
import { updateWork } from "@/lib/agent-versions";
import { returnFocus } from "@/lib/focus";
import { formatBytes } from "@/lib/format";
import type { AgentVersionInfo, InstalledImage } from "@portal/core/wire";
import { FormError } from "@/components/forms/form-error";
import { SubmitButton } from "@/components/forms/submit-button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";

// The agent cards' confirmations, each bound to its server action and closed by it once the gateway accepts:
//   - UpdateConfirmDialog: one prepared change (to latest, using an image on the server, building a version,
//     rebuilding the current one from scratch), with what it costs and what it changes;
//   - RemoveImageDialog: removing an image that is not current and that no workspace uses.
// They send the exact version on screen, never a dist-tag the gateway would resolve against a fresher registry
// answer. Their bodies unmount on close, so each opening starts fresh.

const IDLE: AgentActionState = { status: "idle" };

/** Runs `onDone` once the action has succeeded. */
function useOnDone(state: AgentActionState, onDone: () => void): void {
  const done = useEffectEvent(onDone);
  useEffect(() => {
    if (state.status === "done") done();
  }, [state]);
}

/** The message above the buttons: the action's error, or its input's. */
function formProblem(state: AgentActionState): string | null {
  if (state.status === "error") return state.message;
  if (state.status !== "invalid") return null;
  return Object.values(state.fieldErrors)[0] ?? null;
}

/** What a build costs, said in the confirmations. */
const BUILD_COST = "It builds an image on this server, which takes a few minutes and loads its CPU meanwhile.";
/** What switching to an image on the server costs (updateWork "switch"). */
const SWITCH_COST = "Its image is on this server, so nothing is built: the image is checked and made current in seconds.";

// ---- One prepared change -----------------------------------------------------------------------------------------

/**
 * What a confirmed change does: "update" is the card's "Update to X.Y.Z", "use" and "build" a Package images row's
 * Use… and Build… (the current version's Build… when its image is missing), "rebuild" the current one from scratch.
 */
export type UpdatePlan = { kind: "update" | "use" | "build"; version: string } | { kind: "rebuild" };

interface PlanCopy {
  title: string;
  version: string;
  rebuild: boolean;
  confirm: string;
  pending: string;
  body: ReactNode;
}

function planCopy(plan: UpdatePlan, agent: AgentVersionInfo): PlanCopy {
  const { name, current } = agent;
  const em = (version: string) => <span className="text-foreground">{version}</span>;
  // Said by what the gateway will do now: an image may have been built or removed since the button was drawn.
  const cost = (version: string) => (updateWork(agent, version) === "switch" ? SWITCH_COST : BUILD_COST);
  // The release notes announce breaking changes: said first, so it is read before the button.
  const breaking = (version: string) =>
    agent.releases.find((release) => release.version === version)?.notes?.breaking ? (
      <span className="flex flex-col items-center gap-1.5 sm:items-start">
        <Badge variant="destructive">Breaking changes</Badge>
        <span>Read its release notes first: {em(version)} changes how {name} behaves.</span>
      </span>
    ) : null;
  const change = (version: string) => (
    <>
      {breaking(version)}
      <p>
        New workspaces will start with {em(version)} instead of {em(current)}. {cost(version)}
      </p>
      <p>Running workspaces keep their version until they restart.</p>
    </>
  );
  if (plan.kind === "build" && plan.version === current) {
    return {
      title: `Build ${name} ${current}?`,
      version: current,
      rebuild: false,
      confirm: "Build",
      pending: "Starting…",
      body: (
        <p>
          The image of the current version is missing, so new {name} workspaces can&apos;t start. {BUILD_COST}
        </p>
      ),
    };
  }
  switch (plan.kind) {
    case "update":
      return { title: `Update ${name} to ${plan.version}?`, version: plan.version, rebuild: false, confirm: `Update to ${plan.version}`, pending: "Starting…", body: change(plan.version) };
    case "use":
      return { title: `Use ${name} ${plan.version}?`, version: plan.version, rebuild: false, confirm: `Use ${plan.version}`, pending: "Switching…", body: change(plan.version) };
    case "build":
      return { title: `Build ${name} ${plan.version}?`, version: plan.version, rebuild: false, confirm: `Build ${plan.version}`, pending: "Starting…", body: change(plan.version) };
    case "rebuild":
      return {
        title: `Rebuild ${name} ${current}?`,
        version: current,
        rebuild: true,
        confirm: "Rebuild",
        pending: "Starting…",
        body: (
          <>
            <p>
              Build {em(current)} again from scratch, without the build cache: fresh system packages (Chromium, security
              fixes) and a fresh install of {name}. This takes several minutes and loads the server&apos;s CPU meanwhile.
            </p>
            <p>Running workspaces keep the current build until they restart.</p>
          </>
        ),
      };
  }
}

interface DialogProps {
  agent: AgentVersionInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The gateway accepted: poll now. */
  onDone: () => void;
  /** Gets the focus when the dialog closes: the control that opened it (the dialog has no Trigger of its own). */
  returnFocusTo: RefObject<HTMLElement | null>;
}

export function UpdateConfirmDialog({ plan, agent, open, onOpenChange, onDone, returnFocusTo }: DialogProps & { plan: UpdatePlan }) {
  const copy = planCopy(plan, agent);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
        </AlertDialogHeader>
        <UpdateConfirmForm
          agent={agent}
          copy={copy}
          onDone={() => {
            onOpenChange(false);
            onDone();
          }}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function UpdateConfirmForm({ agent, copy, onDone }: { agent: AgentVersionInfo; copy: PlanCopy; onDone: () => void }) {
  const [state, action] = useActionState(updateAgent, IDLE);
  useOnDone(state, onDone);
  const problem = formProblem(state);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="agent" value={agent.id} />
      <input type="hidden" name="version" value={copy.version} />
      {copy.rebuild ? <input type="hidden" name="rebuild" value="on" /> : null}
      <AlertDialogDescription asChild>
        <div className="flex flex-col gap-2">{copy.body}</div>
      </AlertDialogDescription>
      {problem ? <FormError>{problem}</FormError> : null}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <SubmitButton className="max-w-full min-w-16 shrink" pendingLabel={copy.pending}>
          <span className="truncate">{copy.confirm}</span>
        </SubmitButton>
      </AlertDialogFooter>
    </form>
  );
}

// ---- Removing an image -------------------------------------------------------------------------------------------

/** Once the image is gone, its row and the Remove button go too: onDone points returnFocusTo elsewhere. */
export function RemoveImageDialog({ agent, image, open, onOpenChange, onDone, returnFocusTo }: DialogProps & { image: InstalledImage }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove image?</AlertDialogTitle>
        </AlertDialogHeader>
        <RemoveImageForm
          agent={agent}
          image={image}
          onDone={() => {
            onDone();
            onOpenChange(false);
          }}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RemoveImageForm({ agent, image, onDone }: { agent: AgentVersionInfo; image: InstalledImage; onDone: () => void }) {
  const [state, action] = useActionState(removeAgentImage, IDLE);
  useOnDone(state, onDone);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="agent" value={agent.id} />
      <input type="hidden" name="version" value={image.version} />
      <AlertDialogDescription>
        Remove the {agent.name} <span className="text-foreground">{image.version}</span> image ({formatBytes(image.sizeBytes)})
        from this server? Using {image.version} again later builds it first.
      </AlertDialogDescription>
      {state.status === "error" ? <FormError>{state.message}</FormError> : null}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <SubmitButton variant="destructive" className="min-w-16" pendingLabel="Removing…">
          Remove
        </SubmitButton>
      </AlertDialogFooter>
    </form>
  );
}
