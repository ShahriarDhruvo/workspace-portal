"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentKind } from "@portal/db";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { formatVersion, stopReasonText, workspaceState } from "@/lib/format";
import type { WorkspaceStatusResponse } from "@/lib/gateway-types";
import { stopNeedsConfirm, stopWarnings } from "@/lib/workspace-stop";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRightIcon, PlayIcon, StopIcon, WarningIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { StatusPill } from "./status-pill";
import { StopDialog } from "./stop-dialog";

// Home's one focal point: the user's workspace, with the one thing to do next. Stopped (or failed), the primary
// action is Start, which launches the harness chosen in Settings and goes to /workspace; running, it is "Open
// workspace", with Stop beside it. It polls /api/workspace/status, every 2 s while something is under way.

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
  const [actionError, setActionError] = useState<string | null>(null);
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

  async function start() {
    setRequest("start");
    setActionError(null);
    const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/start", { method: "POST" });
    if (result.ok) {
      setInfo(result.data);
      router.push("/workspace");
      return;
    }
    setRequest(null);
    if (needsReauth(result)) router.refresh();
    else setActionError(result.error.error === "capacity" ? "All workspace slots are busy. Try again in a minute." : result.error.message);
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
    if (problem) setActionError(problem);
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
  // The owner's own Stop (here, on the workspace page or elsewhere) needs no explanation; the pill says Stopped.
  const stoppedBecause = status === "stopped" && info.stopReason !== "user" ? stopReasonText(info.stopReason, idleTimeoutMinutes, "owner") : null;
  const ready = status === "running" && info.ready && request === null;
  const starting = request === "start" || status === "starting" || (status === "running" && !info.ready);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-16">Your workspace</h1>
        </CardTitle>
        <CardDescription className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-14 font-medium text-foreground">{agent ? agentNames[agent] : "No harness enabled"}</span>
          {version ? <span className="font-mono text-12">{formatVersion(version)}</span> : null}
        </CardDescription>
        <CardAction>
          <StatusPill state={state} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === "error" && request === null ? (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>The workspace couldn&apos;t start</AlertTitle>
            <AlertDescription>{info.lastError ?? "Something went wrong while starting it."}</AlertDescription>
          </Alert>
        ) : null}
        {actionError ? (
          <Alert variant="destructive" role="alert">
            <WarningIcon />
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}
        {stoppedBecause ? <p className="text-13 text-muted-foreground">Stopped {stoppedBecause}.</p> : null}
        {changesNextTime && info.nextAgent ? (
          <p className="text-13 text-muted-foreground">
            You chose {agentNames[info.nextAgent]} in Settings. It starts the next time the workspace starts.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {ready ? (
            <>
              <Button asChild size="lg" className="max-sm:flex-1 sm:min-w-40">
                <Link href="/workspace">
                  Open workspace
                  <ArrowRightIcon />
                </Link>
              </Button>
              <Button ref={stopButton} type="button" size="lg" variant="outline" onClick={onStop}>
                <StopIcon />
                Stop
              </Button>
            </>
          ) : starting ? (
            <>
              <Button type="button" size="lg" disabled aria-busy className="max-sm:flex-1">
                <Spinner aria-hidden="true" />
                Starting…
              </Button>
              {status === "starting" || status === "running" ? (
                <Button asChild size="lg" variant="outline">
                  <Link href="/workspace">Open workspace</Link>
                </Button>
              ) : null}
            </>
          ) : status === "stopping" || request === "stop" ? (
            <Button type="button" size="lg" variant="outline" disabled aria-busy className="max-sm:flex-1">
              <Spinner aria-hidden="true" />
              Stopping…
            </Button>
          ) : (
            <Button type="button" size="lg" onClick={start} disabled={info.nextAgent === null} className="max-sm:flex-1 sm:min-w-32">
              <PlayIcon />
              {status === "error" ? "Try again" : "Start"}
            </Button>
          )}
        </div>
        {info.nextAgent === null ? (
          <p className="text-13 text-muted-foreground">No harness is enabled on this server. Ask the administrator.</p>
        ) : null}
        {pollError ? (
          <p role="status" className="text-12 text-muted-foreground">
            Can&apos;t check the workspace right now: {pollError}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex-col items-start gap-1 text-12 text-muted-foreground">
        <p>Idle workspaces stop after {idleTimeoutMinutes} min. Your files are kept.</p>
        {info.nextAgent ? (
          <p>
            Harness: {agentNames[info.nextAgent]}
            {info.agents.length > 1 ? (
              <>
                {" · "}
                <Link href="/settings#harness" className="text-foreground underline-offset-4 hover:underline">
                  Change in Settings
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </CardFooter>
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
