"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { removeAgentImage, updateAgent, type AgentActionState } from "@/lib/actions/agents";
import { updateWork, type UpdateWork } from "@/lib/agent-versions";
import { returnFocus } from "@/lib/focus";
import { formatBytes } from "@/lib/format";
import type { AgentVersionInfo, InstalledImage } from "@/lib/gateway-types";
import { isAgentVersion } from "@/lib/limits";
import { FormError } from "@/components/forms/form-error";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

// The Agents page's dialogs, each bound to its server action and closed by it once the gateway accepts:
//   - UpdateConfirmDialog: one prepared update (to latest, switching to an image on the server, a rebuild from
//     scratch, building a missing image), with what it costs and what it changes;
//   - ChangeVersionDialog: the version of a release channel or any published version, optionally from scratch;
//   - RemoveImageDialog: removing an image that is not current and that no workspace uses.
// They always send an exact version, the one on screen: the gateway would resolve a channel again, against a
// fresher registry answer, and could install a newer version than the admin confirmed. Their bodies unmount on
// close, so each opening starts fresh.

const IDLE: AgentActionState = { status: "idle" };

/** Runs `onDone` once the action has succeeded. */
function useOnDone(state: AgentActionState, onDone: () => void): void {
  const done = useEffectEvent(onDone);
  useEffect(() => {
    if (state.status === "done") done();
  }, [state]);
}

/** The message above the buttons: the action's error, or a field error whose field isn't on screen. */
function formProblem(state: AgentActionState, fieldsShown: readonly string[] = []): string | null {
  if (state.status === "error") return state.message;
  if (state.status !== "invalid") return null;
  return Object.entries(state.fieldErrors).find(([field]) => !fieldsShown.includes(field))?.[1] ?? null;
}

/** What a build costs, said in the confirmations. */
const BUILD_COST = "It builds an image on this server, which takes a few minutes and loads its CPU meanwhile.";
/** What switching to an image on the server costs (updateWork "switch"). */
const SWITCH_COST = "Its image is on this server, so nothing is built: the image is checked and made current in seconds.";

// ---- One prepared update -----------------------------------------------------------------------------------------

/** What a one-click update does: the version it installs and whether it skips the build cache. */
export type UpdatePlan =
  | { kind: "update"; version: string }
  | { kind: "switch"; version: string }
  | { kind: "rebuild" }
  | { kind: "build" };

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
  const cost = (version: string) => (updateWork(agent, version, false) === "switch" ? SWITCH_COST : BUILD_COST);
  switch (plan.kind) {
    case "update":
      return {
        title: `Update ${name}`,
        version: plan.version,
        rebuild: false,
        confirm: `Update to ${plan.version}`,
        pending: "Starting…",
        body: (
          <>
            <p>
              Make {name} {em(plan.version)} the version new workspaces start with. {cost(plan.version)}
            </p>
            <p>Running workspaces keep {em(current)} until they restart.</p>
          </>
        ),
      };
    case "switch":
      return {
        title: `Switch ${name} to ${plan.version}`,
        version: plan.version,
        rebuild: false,
        confirm: `Switch to ${plan.version}`,
        pending: "Switching…",
        body: (
          <>
            <p>
              New workspaces will start with {em(plan.version)} instead of {em(current)}. {cost(plan.version)}
            </p>
            <p>Running workspaces keep their version until they restart.</p>
          </>
        ),
      };
    case "rebuild":
      return {
        title: `Rebuild ${name} ${current}`,
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
    case "build":
      return {
        title: `Build ${name} ${current}`,
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
    <form action={action}>
      <AlertDialogBody>
        <input type="hidden" name="agent" value={agent.id} />
        <input type="hidden" name="version" value={copy.version} />
        {copy.rebuild ? <input type="hidden" name="rebuild" value="on" /> : null}
        <AlertDialogDescription asChild>
          <div className="flex flex-col gap-2">{copy.body}</div>
        </AlertDialogDescription>
        {problem ? <FormError>{problem}</FormError> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <SubmitButton size="sm" className="max-w-full min-w-16 shrink" pendingLabel={copy.pending}>
            <span className="truncate">{copy.confirm}</span>
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogBody>
    </form>
  );
}

// ---- Any version -------------------------------------------------------------------------------------------------

/** The Select's choice for typing a version instead of picking a channel. */
const SPECIFIC = "specific";

const NO_CHANNELS = "The release channels are unknown until the npm registry answers. Enter a version.";

/** What the chosen version takes, under the version list (a channel) or the version field (a typed version). */
const WORK_NOTES: Record<UpdateWork, (version: string, fromScratch: boolean) => string> = {
  none: (version) => `${version} is already the current version. Tick Rebuild from scratch to build it again.`,
  switch: (version) => `${version} is on this server: switching takes seconds, nothing is built.`,
  rebuild: (version) => `${version} is built again from scratch on this server (several minutes, loading its CPU).`,
  build: (version, fromScratch) =>
    fromScratch
      ? `${version} is built from scratch on this server first (several minutes, loading its CPU).`
      : `${version} is built on this server first (a few minutes, loading its CPU).`,
};

/**
 * The confirm button, by the same work ("none" leaves it disabled). A version too long for the dialog is cut
 * short in the button; the note above it has it whole.
 */
const WORK_CONFIRMS: Record<UpdateWork, (version: string) => string> = {
  none: (version) => `Switch to ${version}`,
  switch: (version) => `Switch to ${version}`,
  rebuild: (version) => `Rebuild ${version}`,
  build: (version) => `Build ${version}`,
};

export function ChangeVersionDialog({ agent, open, onOpenChange, onDone, returnFocusTo }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <DialogHeader>
          <DialogTitle>Change {agent.name} version</DialogTitle>
        </DialogHeader>
        <ChangeVersionForm
          agent={agent}
          onDone={() => {
            onOpenChange(false);
            onDone();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ChangeVersionForm({ agent, onDone }: { agent: AgentVersionInfo; onDone: () => void }) {
  const ids = { select: useId(), note: useId(), rebuild: useId() };
  const versionInput = useRef<HTMLInputElement>(null);
  /** "Specific version…" was just picked: the version field takes the focus when the list closes. */
  const typingNext = useRef(false);
  const [state, action, pending] = useActionState(updateAgent, IDLE);
  const [choice, setChoice] = useState(agent.channels[0]?.tag ?? SPECIFIC);
  const [typed, setTyped] = useState("");
  const [rebuild, setRebuild] = useState(false);
  /** The choice the last submit was for: the action's errors are about it, so they show only while it is chosen. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  useOnDone(state, onDone);

  const channel = agent.channels.find((candidate) => candidate.tag === choice) ?? null;
  // The version to install: the channel's, or the typed one once it is a version by the action's own rule.
  const version = channel ? channel.version : isAgentVersion(typed.trim()) ? typed.trim() : null;
  const work = version ? updateWork(agent, version, rebuild) : null;
  const shown = submitted === choice ? state : IDLE;
  const versionError = !channel && shown.status === "invalid" ? shown.fieldErrors.version : undefined;
  const problem = formProblem(shown, channel ? [] : ["version"]);

  useEffect(() => {
    if (versionError) versionInput.current?.focus();
  }, [versionError, state]);

  // Dispatched from onSubmit rather than <form action>: React resets a form after its action, and the Select and
  // Checkbox would follow that reset back to their first values, the typed version gone with them.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (work === "none") return;
    const data = new FormData(event.currentTarget);
    setSubmitted(choice);
    startTransition(() => action(data));
  }
  const confirm = version && work ? WORK_CONFIRMS[work](version) : "Switch version";
  const workNote = version && work ? WORK_NOTES[work](version, rebuild) : null;
  // Under the list: what the channel's version takes, or why there is no channel to choose. A typed version's
  // note goes under its field.
  const note = channel ? workNote : agent.channels.length === 0 ? NO_CHANNELS : null;

  return (
    <form onSubmit={submit}>
      <DialogBody>
        <input type="hidden" name="agent" value={agent.id} />
        {/* The version the channel names on screen, not the channel: see the top of this file. */}
        {channel ? <input type="hidden" name="version" value={channel.version} /> : null}
        <DialogDescription>
          Makes the chosen version the one new workspaces start with; an older one rolls back. A version whose image
          is on this server switches in seconds; any other is built here first (a few minutes, loading its CPU).
          Running workspaces keep theirs until they restart.
        </DialogDescription>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor={ids.select}>Version</FieldLabel>
            <Select
              value={choice}
              onValueChange={(value) => {
                typingNext.current = value === SPECIFIC;
                setChoice(value);
              }}
            >
              <SelectTrigger id={ids.select} className="w-full" autoFocus aria-describedby={note ? ids.note : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                onCloseAutoFocus={(event) => {
                  if (!typingNext.current || !versionInput.current) return;
                  typingNext.current = false;
                  event.preventDefault();
                  versionInput.current.focus();
                }}
              >
                {agent.channels.map((option) => (
                  <SelectItem key={option.tag} value={option.tag}>
                    <span className="shrink-0">{option.tag}</span>
                    <span className="min-w-0 break-all text-muted-foreground">
                      {option.version}
                      {option.version === agent.current ? " (current)" : ""}
                    </span>
                  </SelectItem>
                ))}
                {agent.channels.length > 0 ? <SelectSeparator /> : null}
                <SelectItem value={SPECIFIC}>Specific version…</SelectItem>
              </SelectContent>
            </Select>
            {note ? <FieldDescription id={ids.note}>{note}</FieldDescription> : null}
          </Field>
          {channel ? null : (
            <FormField
              ref={versionInput}
              label="Version number"
              name="version"
              placeholder="e.g. 0.27.4"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              hint={[`A version of ${agent.packageName} published on npm.`, workNote].filter(Boolean).join(" ")}
              error={versionError}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              mono
            />
          )}
          <Field orientation="horizontal">
            <Checkbox
              id={ids.rebuild}
              name="rebuild"
              checked={rebuild}
              onCheckedChange={(checked) => setRebuild(checked === true)}
              aria-describedby={`${ids.rebuild}-hint`}
            />
            <FieldContent>
              <FieldLabel htmlFor={ids.rebuild}>Rebuild from scratch</FieldLabel>
              <FieldDescription id={`${ids.rebuild}-hint`}>
                Builds the image even if it is on this server, without the build cache: system packages (Chromium,
                security fixes) are fetched fresh too. Slower.
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>
        {problem ? <FormError>{problem}</FormError> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <SubmitButton
            size="sm"
            className="max-w-full min-w-16 shrink"
            pending={pending}
            pendingLabel="Starting…"
            disabled={work === "none"}
          >
            <span className="truncate">{confirm}</span>
          </SubmitButton>
        </DialogFooter>
      </DialogBody>
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
          <AlertDialogTitle>Remove image</AlertDialogTitle>
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
    <form action={action}>
      <AlertDialogBody>
        <input type="hidden" name="agent" value={agent.id} />
        <input type="hidden" name="version" value={image.version} />
        <AlertDialogDescription>
          Remove the {agent.name} <span className="text-foreground">{image.version}</span> image ({formatBytes(image.sizeBytes)})
          from this server? Switching back to {image.version} later builds it again.
        </AlertDialogDescription>
        {state.status === "error" ? <FormError>{state.message}</FormError> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <SubmitButton variant="destructive" size="sm" className="min-w-16" pendingLabel="Removing…">
            Remove
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogBody>
    </form>
  );
}
