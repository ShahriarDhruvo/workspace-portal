"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AGENT_NAMES, WORKSPACE_KIND_NAMES, type AgentKind, type WorkspaceKind, type WorkspaceStatus } from "@portal/core/wire";
import { saveHarness } from "@/lib/actions/settings";
import { fetchJson, needsReauth, startWorkspace, stopWorkspace } from "@/lib/fetch-json";
import { formatVersion, stopReasonText, workspaceState } from "@/lib/format";
import type { WorkspaceStatusResponse } from "@/lib/api";
import type { ActionResult } from "@/lib/validation";
import { initialKind, onlineAccessAfter, otherKind, startErrorText } from "@/lib/workspace-kind";
import { stopWarnings } from "@/lib/workspace-stop";
import { usePoll } from "@/components/common/use-poll";
import { FormError } from "@/components/forms/form-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRightIcon, StopIcon, WarningIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { HarnessPicker, useHarnessChoice } from "./harness-picker";
import { KindBadge } from "./kind-badge";
import { KindPicker, StartWorkspaceButton, useKindChoice } from "./start-workspace";
import { StopDialog } from "./stop-dialog";

// Home's one focal point: the user's workspace, with the one thing to do next as the button in the card's corner.
// Stopped, it asks what Start launches: Private or Online, and the harness when the install offers more than one.

/**
 * The stop reasons worth a line on the card. Not the owner's own Stop or sign-out, and not an idle stop: the
 * card's footer already says idle workspaces stop.
 */
const NOTED_STOP_REASONS = new Set(["admin", "capacity", "error", "online_disabled", "online_not_allowed"]);

interface HomeCardProps {
  /** The workspace as the page rendered it; null when the gateway couldn't be asked. */
  initial: WorkspaceStatusResponse | null;
  /** Why `initial` is missing. */
  initialError: string | null;
  idleTimeoutMinutes: number;
}

export function HomeCard({ initial, initialError, idleTimeoutMinutes }: HomeCardProps) {
  const router = useRouter();
  const [info, setInfo] = useState(initial);
  const [pollError, setPollError] = useState(initialError);
  /** "start" or "stop" while that request runs. */
  const [request, setRequest] = useState<"start" | "stop" | null>(null);
  /** The kind the last Start asked for: the badge's until the gateway's answer names it. */
  const [startedKind, setStartedKind] = useState<WorkspaceKind>("private");
  /**
   * Why the last Start or Stop failed, and the workspace's status then: it shows while the workspace stays in that
   * status (the other kind running, all slots busy) and goes once that changes (stopped by the administrator).
   */
  const [actionError, setActionError] = useState<{ message: string; status: WorkspaceStatus | null } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  const choice = useKindChoice(info?.online ?? "off", info ? initialKind(info) : "private");
  const harness = useHarnessChoice(info?.nextAgent ?? null, saveOwnHarness);

  /** Saves the harness picked here; the card shows it as saved at once, not after the next poll. */
  async function saveOwnHarness(agent: AgentKind): Promise<ActionResult> {
    const result = await saveHarness(agent);
    if (result.ok) setInfo((current) => (current ? { ...current, nextAgent: agent } : current));
    return result;
  }

  const status = info?.status ?? null;
  const settling = request !== null || status === "starting" || status === "stopping" || (status === "running" && !info?.ready);
  // Not while a harness is being saved: an answer from before the save would bring the earlier harness back.
  usePoll<WorkspaceStatusResponse>(harness.saving ? null : "/api/workspace/status", settling ? 2_000 : 5_000, (result) => {
    if (result.ok) setInfo(result.data);
    setPollError(result.ok ? null : result.error.message);
  });

  /** Starts the kind confirmed in the start dialog, then goes to the workspace page. */
  async function start(kind: WorkspaceKind) {
    setRequest("start");
    setStartedKind(kind);
    setActionError(null);
    const result = await startWorkspace(kind);
    if (result.ok) {
      setInfo(result.data);
      router.push("/workspace");
      return;
    }
    setRequest(null);
    if (needsReauth(result)) {
      router.refresh();
      return;
    }
    // Refused for Online access: the picker shows Online unavailable at once, not after the next poll.
    const online = onlineAccessAfter(result.error);
    if (online) setInfo((current) => (current ? { ...current, online } : current));
    // The refusal may come from a change elsewhere (the other kind started in another tab): show it now.
    const fresh = await fetchJson<WorkspaceStatusResponse>("/api/workspace/status");
    if (fresh.ok) setInfo(fresh.data);
    setActionError({ message: startErrorText(result.error, kind, "Your"), status: fresh.ok ? fresh.data.status : status });
  }

  async function stop(): Promise<ActionResult> {
    setRequest("stop");
    setActionError(null);
    const result = await stopWorkspace();
    setRequest(null);
    if (result.ok) setInfo(result.data);
    else if (needsReauth(result)) router.refresh();
    else return { ok: false, message: result.error.message };
    return { ok: true };
  }

  if (!info) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-16">Your workspace</h1>
          </CardTitle>
          <CardDescription>The workspace service can&apos;t be reached right now. This page keeps checking.</CardDescription>
        </CardHeader>
        {pollError ? (
          <CardContent>
            <p className="text-13 text-muted-foreground">{pollError}</p>
          </CardContent>
        ) : null}
      </Card>
    );
  }

  const active = status === "starting" || status === "running";
  const state = request === "start" ? workspaceState({ status: "starting", ready: false, busy: false }) : workspaceState(info);
  // The harness of the running workspace; stopped, the one Start launches (the user's choice in the card).
  const agent = active ? info.agent : harness.value;
  const version = active ? info.agentVersion : info.agents.find((offered) => offered.id === harness.value)?.version ?? null;
  const changesNextTime = active && info.nextAgent !== null && info.agent !== info.nextAgent;
  const stoppedBecause =
    status === "stopped" && info.stopReason !== null && NOTED_STOP_REASONS.has(info.stopReason)
      ? stopReasonText(info.stopReason, idleTimeoutMinutes, "owner")
      : null;
  const ready = status === "running" && info.ready && request === null;
  const starting = request === "start" || status === "starting" || (status === "running" && !info.ready);
  const stopping = status === "stopping" || request === "stop";
  const kind = request === "start" ? startedKind : info.kind;
  const error = actionError?.status === status ? actionError.message : null;
  // A failed Start says why it failed; that replaces the earlier failure's explanation.
  const failed = status === "error" && request === null && error === null;
  const notes = failed || error || stoppedBecause || changesNextTime || pollError;
  const choosing = !(ready || starting || stopping);
  // A start launches the saved harness, so not before the one just picked is saved.
  const canStart = harness.value !== null && !harness.saving;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-16">Your workspace</h1>
        </CardTitle>
        <CardDescription className="col-start-1 flex flex-wrap items-baseline gap-x-2">
          {agent ? (
            <>
              <span className="text-14 font-medium text-foreground">{AGENT_NAMES[agent]}</span>
              {version ? <span className="font-mono text-12">{formatVersion(version)}</span> : null}
            </>
          ) : (
            "No harness is enabled. Ask the administrator."
          )}
        </CardDescription>
        {/* Top right on wider screens; on a phone, a full-width row under the title, the buttons sharing its width. */}
        <CardAction className="flex items-center gap-2 max-sm:col-span-2 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch max-sm:pt-3 max-sm:*:not-data-[slot=badge]:flex-1">
          {ready || starting || stopping ? <KindBadge kind={kind} /> : null}
          {ready ? (
            <>
              <Button ref={stopButton} type="button" variant="outline" onClick={() => setConfirmOpen(true)}>
                <StopIcon />
                Stop
              </Button>
              <Button asChild>
                <Link href="/workspace">
                  Open workspace
                  <ArrowRightIcon />
                </Link>
              </Button>
            </>
          ) : starting ? (
            <Button type="button" disabled aria-busy>
              <Spinner aria-hidden="true" />
              Starting…
            </Button>
          ) : stopping ? (
            <Button type="button" variant="outline" disabled aria-busy>
              <Spinner aria-hidden="true" />
              Stopping…
            </Button>
          ) : (
            <StartWorkspaceButton
              kind={choice.kind}
              onSwitch={choice.onlineBlocked ? undefined : () => choice.choose(otherKind(choice.kind))}
              whose="your"
              retry={status === "error"}
              disabled={!canStart}
              onStart={start}
            />
          )}
        </CardAction>
        {/* The buttons show the state; this says it to screen readers as it changes. */}
        <p role="status" className="sr-only">
          {ready || starting || stopping ? `${WORKSPACE_KIND_NAMES[kind]} workspace` : "Workspace"}{" "}
          {state.activity ? `${state.label.toLowerCase()}, ${state.activity}` : state.label.toLowerCase()}
        </p>
      </CardHeader>
      {notes || choosing ? (
        <CardContent className="flex flex-col gap-3">
          {failed ? (
            <Alert variant="destructive">
              <WarningIcon />
              <AlertTitle>The {WORKSPACE_KIND_NAMES[info.kind]} workspace couldn&apos;t start</AlertTitle>
              <AlertDescription>{info.lastError ?? "Something went wrong while starting it."}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert">
              <WarningIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {stoppedBecause ? <p className="text-13 text-muted-foreground">Stopped {stoppedBecause}.</p> : null}
          {changesNextTime && info.nextAgent ? (
            <p className="text-13 text-muted-foreground">{AGENT_NAMES[info.nextAgent]} starts next time.</p>
          ) : null}
          {pollError ? (
            <p role="status" className="text-13 text-muted-foreground">
              Can&apos;t check the workspace right now: {pollError}
            </p>
          ) : null}
          {choosing ? (
            <KindPicker
              value={choice.kind}
              onValueChange={choice.choose}
              onlineBlocked={choice.onlineBlocked}
              idPrefix="home-kind"
              className="sm:grid-cols-2"
            />
          ) : null}
          {choosing && harness.value !== null && info.agents.length > 1 ? (
            <HarnessPicker agents={info.agents} value={harness.value} onValueChange={harness.choose} saving={harness.saving} />
          ) : null}
          {choosing && harness.error ? <FormError>{harness.error}</FormError> : null}
        </CardContent>
      ) : null}
      <CardFooter className="text-13 text-muted-foreground">Idle workspaces stop after {idleTimeoutMinutes} min.</CardFooter>
      <StopDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        kind="stop"
        warnings={stopWarnings(info, false)}
        onConfirm={stop}
        returnFocusTo={stopButton}
      />
    </Card>
  );
}
