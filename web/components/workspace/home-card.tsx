"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentKind, WorkspaceKind, WorkspaceStatus } from "@portal/db";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { formatVersion, stopReasonText, workspaceState } from "@/lib/format";
import type { WorkspaceStatusResponse } from "@/lib/gateway-types";
import { initialKind, KIND_NAMES, onlineAccessAfter, startErrorText } from "@/lib/workspace-kind";
import { stopNeedsConfirm, stopWarnings } from "@/lib/workspace-stop";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRightIcon, StopIcon, WarningIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { KindBadge } from "./kind-badge";
import { StartWorkspace } from "./start-workspace";
import { StopDialog } from "./stop-dialog";

// Home's one focal point: the user's workspace, with the one thing to do next in the card's top right corner, where
// the button itself says the state: the Private | Online switch and Start (or Try again), "Starting…", "Open
// workspace" with Stop beside it, or "Stopping…"; while a workspace is there, its kind's badge takes the switch's
// place. Start confirms the chosen kind first, then launches the harness chosen in Settings and goes to
// /workspace. It polls /api/workspace/status, every 2 s while something is under way.

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
  agentNames: Readonly<Record<AgentKind, string>>;
}

export function HomeCard({ initial, initialError, idleTimeoutMinutes, agentNames }: HomeCardProps) {
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

  const status = info?.status ?? null;
  const settling = request !== null || status === "starting" || status === "stopping" || (status === "running" && !info?.ready);
  const delay = useRef(2_000);
  useEffect(() => {
    delay.current = settling ? 2_000 : 5_000;
  }, [settling]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/status", { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        setInfo(result.data);
        setPollError(null);
      } else if (needsReauth(result)) {
        router.refresh();
        return;
      } else {
        setPollError(result.error.message);
      }
      timer = setTimeout(poll, delay.current);
    };
    timer = setTimeout(poll, delay.current);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [router]);

  /** Starts the kind confirmed in the start dialog, then goes to the workspace page. */
  async function start(kind: WorkspaceKind) {
    setRequest("start");
    setStartedKind(kind);
    setActionError(null);
    const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
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
    // Refused for Online access: the switch shows Online unavailable at once, not after the next poll.
    const online = onlineAccessAfter(result.error);
    if (online) setInfo((current) => (current ? { ...current, online } : current));
    // The refusal may come from a change elsewhere (the other kind started in another tab): show it now.
    const fresh = await fetchJson<WorkspaceStatusResponse>("/api/workspace/status");
    if (fresh.ok) setInfo(fresh.data);
    setActionError({ message: startErrorText(result.error, kind, "Your"), status: fresh.ok ? fresh.data.status : status });
  }

  /** Stops the workspace; resolves to an error message when it couldn't. */
  async function stop(): Promise<string | null> {
    setRequest("stop");
    setActionError(null);
    const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/stop", { method: "POST" });
    setRequest(null);
    if (result.ok) {
      setInfo(result.data);
      return null;
    }
    if (needsReauth(result)) {
      router.refresh();
      return null;
    }
    return result.error.message;
  }

  async function onStop() {
    if (info && stopNeedsConfirm(stopWarnings(info, false))) {
      setConfirmOpen(true);
      return;
    }
    const problem = await stop();
    if (problem) setActionError({ message: problem, status });
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
  // The harness of the running workspace; stopped, the one Start launches (the user's choice in Settings).
  const agent = active ? info.agent : info.nextAgent;
  const version = active ? info.agentVersion : info.agents.find((offered) => offered.id === info.nextAgent)?.version ?? null;
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-16">Your workspace</h1>
        </CardTitle>
        <CardDescription className="col-start-1 flex flex-wrap items-baseline gap-x-2">
          {agent ? (
            <>
              <span className="text-14 font-medium text-foreground">{agentNames[agent]}</span>
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
              <Button ref={stopButton} type="button" variant="outline" onClick={onStop}>
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
            <StartWorkspace
              online={info.online}
              initialKind={initialKind(info)}
              whose="your"
              label={status === "error" ? "Try again" : "Start"}
              disabled={info.nextAgent === null}
              onStart={start}
              switchClassName="max-sm:*:flex-1"
            />
          )}
        </CardAction>
        {/* The buttons show the state; this says it to screen readers as it changes. */}
        <p role="status" className="sr-only">
          {ready || starting || stopping ? `${KIND_NAMES[kind]} workspace` : "Workspace"}{" "}
          {state.activity ? `${state.label.toLowerCase()}, ${state.activity}` : state.label.toLowerCase()}
        </p>
      </CardHeader>
      {notes ? (
        <CardContent className="flex flex-col gap-3">
          {failed ? (
            <Alert variant="destructive">
              <WarningIcon />
              <AlertTitle>The {KIND_NAMES[info.kind]} workspace couldn&apos;t start</AlertTitle>
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
            <p className="text-13 text-muted-foreground">{agentNames[info.nextAgent]}, chosen in Settings, starts next time.</p>
          ) : null}
          {pollError ? (
            <p role="status" className="text-13 text-muted-foreground">
              Can&apos;t check the workspace right now: {pollError}
            </p>
          ) : null}
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
