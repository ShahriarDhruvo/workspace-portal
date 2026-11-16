"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentKind } from "@portal/db";
import { agentFrameUrl, type AgentFrame } from "@/lib/agent-url";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { stopReasonText, workspaceState, type WorkspaceState } from "@/lib/format";
import type { ApiError, WorkspaceStatusResponse } from "@/lib/gateway-types";
import { stopNeedsConfirm, stopWarnings } from "@/lib/workspace-stop";
import { PortalMark } from "@/components/brand";
import { BarMenu } from "@/components/common/bar-menu";
import { useTheme } from "@/components/common/theme";
import { ThemeToggle } from "@/components/common/theme-toggle";
import type { Viewer } from "@/components/layout/app-header";
import { HeaderBar } from "@/components/layout/header-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { CloseIcon, EyeIcon, HomeIcon, PlayIcon, SettingsIcon, ShieldIcon, StopIcon, WarningIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { BootScreen } from "./boot-screen";
import { StateCard } from "./state-card";
import { StatusPill } from "./status-pill";
import { StopDialog } from "./stop-dialog";

// The /workspace page body: a slim 46px top bar and the workspace's agent (Qwen Code or DeepSeek Harness) in an
// iframe, served by the gateway on the workspace's own port (AGENT_PORT_BASE + user id). It polls
// /api/workspace/status (2 s until ready, then 10 s) and only mounts the iframe once the agent is ready.
// Nothing here starts a workspace by itself: stopped, it says so and offers Start (the owner's harness from
// Settings). Stop (own workspace only) asks first when it would interrupt something, then goes back to Home.

interface WorkspaceShellProps {
  viewer: Viewer;
  /** Whose workspace this page shows; the gateway routes by the session's target, which must match. */
  target: { id: number; name: string; isViewer: boolean };
  /** null when the user id is outside AGENT_PORT_COUNT (the page then explains it). */
  frame: AgentFrame | null;
  idleTimeoutMinutes: number;
  /** Display names of all agent kinds (AGENT_NAMES), so a running agent is named even if no longer enabled. */
  agentNames: Readonly<Record<AgentKind, string>>;
  /** Rendered above the top bar (the red-tinted "viewing" banner for admins). */
  banner?: ReactNode;
}

interface State {
  info: WorkspaceStatusResponse | null;
  pollError: ApiError | null;
  /** A start request is in flight. */
  starting: boolean;
  startError: ApiError | null;
  /** Seen starting or running since the page loaded, so a later "stopped" means it was stopped on us. */
  active: boolean;
  /** The user's own Stop is under way or done: the page shows "Stopping" until Home takes over. */
  leaving: boolean;
  /** Why the last Stop without a confirmation failed, until dismissed. */
  stopError: string | null;
}

type Action =
  | { type: "status"; info: WorkspaceStatusResponse }
  | { type: "pollFailed"; error: ApiError }
  | { type: "startRequested" }
  | { type: "startSucceeded"; info: WorkspaceStatusResponse }
  | { type: "startFailed"; error: ApiError }
  | { type: "stopRequested" }
  | { type: "stopFailed"; message: string | null }
  | { type: "stopErrorDismissed" };

const INITIAL: State = {
  info: null,
  pollError: null,
  starting: false,
  startError: null,
  active: false,
  leaving: false,
  stopError: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "status": {
      const running = action.info.status === "starting" || action.info.status === "running";
      return {
        ...state,
        info: action.info,
        pollError: null,
        active: state.active || running,
        startError: action.info.ready ? null : state.startError,
      };
    }
    case "pollFailed":
      return { ...state, pollError: action.error };
    case "startRequested":
      return { ...state, starting: true, startError: null };
    case "startSucceeded":
      return { ...state, starting: false, info: action.info, pollError: null, active: true };
    case "startFailed":
      return { ...state, starting: false, startError: action.error };
    case "stopRequested":
      return { ...state, leaving: true, stopError: null };
    case "stopFailed":
      return { ...state, leaving: false, stopError: action.message };
    case "stopErrorDismissed":
      return { ...state, stopError: null };
  }
}

/** Nothing runs in the workspace: it needs the person's Start. */
type Idle =
  /** On arrival. */
  | { kind: "fresh" }
  /** Stopped while this page had it open. */
  | { kind: "stopped"; reason: string | null }
  | { kind: "capacity" }
  | { kind: "failed"; message: string | null };

type Phase =
  | { kind: "connecting" }
  | { kind: "starting" }
  | { kind: "stopping" }
  | { kind: "ready" }
  | { kind: "idle"; idle: Idle }
  | { kind: "unreachable"; message: string }
  | { kind: "switched" };

const UNREACHABLE = new Set(["unreachable", "network"]);

function phaseOf(state: State, targetId: number): Phase {
  const { info } = state;
  if (info && info.targetUserId !== targetId) return { kind: "switched" };
  if (state.leaving) return { kind: "stopping" };
  const ready = info?.status === "running" && info.ready;
  // Keep a working iframe through a failed poll; the agent's page shows its own connection state.
  if (state.pollError) return ready ? { kind: "ready" } : { kind: "unreachable", message: state.pollError.message };
  if (ready) return { kind: "ready" };
  if (state.starting) return { kind: "starting" };
  if (state.startError && UNREACHABLE.has(state.startError.error)) {
    return { kind: "unreachable", message: state.startError.message };
  }
  if (!info) return { kind: "connecting" };
  if (state.startError) {
    return { kind: "idle", idle: state.startError.error === "capacity" ? { kind: "capacity" } : { kind: "failed", message: state.startError.message } };
  }
  switch (info.status) {
    case "starting":
    case "running":
      return { kind: "starting" };
    case "stopping":
      return { kind: "stopping" };
    case "error":
      return { kind: "idle", idle: { kind: "failed", message: info.lastError } };
    case "stopped":
      return { kind: "idle", idle: state.active ? { kind: "stopped", reason: info.stopReason } : { kind: "fresh" } };
  }
}

const STARTING: WorkspaceState = { tone: "warning", label: "Starting", activity: null, pulse: true };
const STOPPING: WorkspaceState = { tone: "warning", label: "Stopping", activity: null, pulse: true };
const STOPPED: WorkspaceState = { tone: "idle", label: "Stopped", activity: null, pulse: false };
const ERROR: WorkspaceState = { tone: "danger", label: "Error", activity: null, pulse: false };

/** The bar's status pill for each phase. */
function pillOf(phase: Phase, state: State): WorkspaceState {
  switch (phase.kind) {
    case "ready":
      return state.pollError || !state.info ? ERROR : workspaceState(state.info);
    case "connecting":
    case "starting":
      return STARTING;
    case "stopping":
      return STOPPING;
    case "switched":
      return STOPPED;
    case "idle":
      return phase.idle.kind === "fresh" || phase.idle.kind === "stopped" ? STOPPED : ERROR;
    case "unreachable":
      return ERROR;
  }
}

/** What "Admin connected" means, for the pill's tooltip and the menu. */
const ADMIN_CONNECTED = "An administrator has your workspace open";

/** What a not-running workspace says, and what its Start button is called. */
function idleCopy(
  idle: Idle,
  target: WorkspaceShellProps["target"],
  harness: string | null,
  idleTimeoutMinutes: number,
): { title: string; body: string; warning: boolean; action: string } {
  const whose = target.isViewer ? "Your" : `${target.name}'s`;
  const starts = harness ? `Start launches ${harness}. ` : "";
  switch (idle.kind) {
    case "fresh":
      return {
        title: `${whose} workspace is stopped`,
        body: `${starts}Files in the workspace are kept.`,
        warning: false,
        action: "Start",
      };
    case "stopped": {
      const reason = stopReasonText(idle.reason, idleTimeoutMinutes, target.isViewer ? "owner" : "other");
      return {
        title: `${whose} workspace was stopped`,
        body: `${reason ? `It was stopped ${reason}. ` : ""}Files in the workspace are kept.`,
        warning: false,
        action: "Start again",
      };
    }
    case "capacity":
      return {
        title: "The workspace can't start yet",
        body: "All workspace slots are busy. Try again in a minute.",
        warning: true,
        action: "Try again",
      };
    case "failed":
      return {
        title: "The workspace couldn't start",
        body: idle.message ?? "Something went wrong while starting it.",
        warning: true,
        action: "Try again",
      };
  }
}

const noopSubscribe = () => () => {};

export function WorkspaceShell({ viewer, target, frame, idleTimeoutMinutes, agentNames, banner }: WorkspaceShellProps) {
  const router = useRouter();
  const theme = useTheme();
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [pollRound, pollNow] = useReducer((n: number) => n + 1, 0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  const delay = useRef(2_000);

  const { info } = state;
  const phase = phaseOf(state, target.id);
  const switched = phase.kind === "switched";
  const pill = pillOf(phase, state);
  const running = info?.status === "starting" || info?.status === "running" ? info : null;
  const runningAgent = running?.agent ?? null;
  // Needs window.location, so it is only known in the browser (null while server rendering).
  const agentUrl = useSyncExternalStore(
    noopSubscribe,
    () => (frame && runningAgent ? agentFrameUrl(window.location, frame, runningAgent, theme) : null),
    () => null,
  );
  const adminConnected = target.isViewer && (info?.connections.admin ?? 0) > 0;
  // Only the owner stops their workspace here; an admin viewing it has Exit (and the console's Stop).
  const canStop = target.isViewer && running !== null && !state.leaving;
  const warnings = info ? stopWarnings(info, true) : null;

  const pollDelay = phase.kind === "connecting" || phase.kind === "starting" || phase.kind === "stopping" ? 2_000 : 10_000;
  useEffect(() => {
    delay.current = pollDelay;
  }, [pollDelay]);

  useEffect(() => {
    if (switched) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/status", { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        dispatch({ type: "status", info: result.data });
      } else if (needsReauth(result)) {
        router.refresh();
        return;
      } else {
        dispatch({ type: "pollFailed", error: result.error });
      }
      timer = setTimeout(poll, delay.current);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pollRound, switched, router]);

  async function start() {
    dispatch({ type: "startRequested" });
    pollNow();
    const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/start", { method: "POST" });
    if (result.ok) dispatch({ type: "startSucceeded", info: result.data });
    else if (needsReauth(result)) router.refresh();
    else dispatch({ type: "startFailed", error: result.error });
  }

  /** Stops the user's workspace, then goes Home; resolves to an error message when it couldn't. */
  async function stop(): Promise<string | null> {
    dispatch({ type: "stopRequested" });
    const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/stop", { method: "POST" });
    if (result.ok) {
      router.push("/");
      return null;
    }
    if (needsReauth(result)) {
      router.refresh();
      return null;
    }
    dispatch({ type: "stopFailed", message: null });
    return result.error.message;
  }

  async function onStop() {
    if (warnings && stopNeedsConfirm(warnings)) {
      setConfirmOpen(true);
      return;
    }
    const problem = await stop();
    if (problem) dispatch({ type: "stopFailed", message: problem });
  }

  const harness = info?.nextAgent ? agentNames[info.nextAgent] : null;
  const home = target.isViewer ? (
    <Button asChild variant="outline">
      <Link href="/">
        <HomeIcon />
        Home
      </Link>
    </Button>
  ) : null;

  let content: ReactNode;
  switch (phase.kind) {
    case "ready":
      content = agentUrl ? (
        <iframe
          key={agentUrl}
          src={agentUrl}
          title={`${target.isViewer ? "Your" : `${target.name}'s`} workspace`}
          allow="clipboard-read; clipboard-write; fullscreen"
          className="absolute inset-0 size-full border-0 bg-background"
        />
      ) : frame === null ? (
        <StateCard title="This workspace can't be shown" warning actions={home}>
          Its account number is beyond the portal&apos;s workspace port range. Ask the administrator to raise
          AGENT_PORT_COUNT.
        </StateCard>
      ) : null;
      break;
    case "connecting":
    case "starting":
      content = <BootScreen hint={`Starting ${target.isViewer ? "your" : `${target.name}'s`} workspace…`} />;
      break;
    case "stopping":
      content = <BootScreen hint={`Stopping ${target.isViewer ? "your" : `${target.name}'s`} workspace…`} />;
      break;
    case "idle": {
      const copy = idleCopy(phase.idle, target, harness, idleTimeoutMinutes);
      content = (
        <StateCard
          title={copy.title}
          warning={copy.warning}
          actions={
            <>
              {home}
              <Button type="button" onClick={start} disabled={info?.nextAgent === null}>
                <PlayIcon />
                {copy.action}
              </Button>
            </>
          }
        >
          {info?.nextAgent === null ? "No harness is enabled on this server. Ask the administrator." : copy.body}
        </StateCard>
      );
      break;
    }
    case "unreachable":
      content = (
        <StateCard
          title="Can't reach the workspace service"
          warning
          actions={
            <>
              {home}
              <Button type="button" onClick={state.startError ? start : pollNow}>
                Try again
              </Button>
            </>
          }
        >
          {phase.message} It may be restarting; this page keeps checking.
        </StateCard>
      );
      break;
    case "switched":
      content = (
        <StateCard
          title="This page is out of date"
          actions={
            <Button type="button" onClick={() => router.refresh()}>
              Reload
            </Button>
          }
        >
          Your session now shows a different workspace, probably from another tab.
        </StateCard>
      );
      break;
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {banner}
      <HeaderBar sticky={false}>
        <Link
          href={target.isViewer ? "/" : "/admin"}
          aria-label={target.isViewer ? "Home" : "Admin"}
          className="hit-area relative shrink-0 rounded-sm"
        >
          <PortalMark />
        </Link>
        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
        <StatusPill state={pill} />
        {runningAgent ? (
          <span className="min-w-0 truncate text-13 font-medium max-sm:hidden">
            <span className="sr-only">Harness: </span>
            {agentNames[runningAgent]}
          </span>
        ) : null}
        {adminConnected ? (
          // On the narrowest phones the label is cut short rather than pushing the buttons off the bar.
          <Badge role="status" title={ADMIN_CONNECTED} variant="warning" className="min-w-0 shrink">
            <EyeIcon />
            <span className="truncate">Admin connected</span>
          </Badge>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {canStop ? (
            <Button ref={stopButton} type="button" variant="outline" size="sm" onClick={onStop}>
              <StopIcon />
              Stop
            </Button>
          ) : state.leaving ? (
            <Button type="button" variant="outline" size="sm" disabled aria-busy>
              <Spinner aria-hidden="true" />
              Stopping…
            </Button>
          ) : null}
          <ThemeToggle />
          <BarMenu viewer={viewer} trigger="avatar">
            {runningAgent ? (
              <DropdownMenuLabel>
                Harness: <span className="text-foreground">{agentNames[runningAgent]}</span>
              </DropdownMenuLabel>
            ) : null}
            {adminConnected ? (
              // The bar's pill may be cut short, and its tooltip needs a mouse.
              <DropdownMenuLabel className="flex gap-2 text-warning">
                <EyeIcon className="shrink-0" />
                {ADMIN_CONNECTED}
              </DropdownMenuLabel>
            ) : null}
            {runningAgent || adminConnected ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem asChild>
              <Link href="/">
                <HomeIcon />
                Home
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <SettingsIcon />
                Settings
              </Link>
            </DropdownMenuItem>
            {viewer.isAdmin ? (
              <DropdownMenuItem asChild>
                <Link href="/admin">
                  <ShieldIcon />
                  Admin
                </Link>
              </DropdownMenuItem>
            ) : null}
          </BarMenu>
        </div>
      </HeaderBar>
      {state.stopError ? (
        <div
          role="alert"
          className="flex min-h-9 shrink-0 items-center gap-2.5 border-b bg-card px-5 py-1 text-13 text-foreground max-sm:px-4"
        >
          <WarningIcon className="shrink-0 text-attention" />
          <span className="min-w-0 flex-1">{state.stopError}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => dispatch({ type: "stopErrorDismissed" })}>
            <CloseIcon />
          </Button>
        </div>
      ) : null}
      <main className="relative min-h-0 flex-1">
        {phase.kind === "ready" ? (
          content
        ) : (
          // Centred by auto margins, which keep the top of a card taller than the screen in reach.
          <div className="absolute inset-0 flex overflow-y-auto p-6 max-sm:p-4">
            <div className="m-auto flex w-full justify-center">{content}</div>
          </div>
        )}
      </main>
      {warnings ? (
        <StopDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          kind="stop"
          warnings={warnings}
          onConfirm={stop}
          returnFocusTo={stopButton}
        />
      ) : null}
    </div>
  );
}
