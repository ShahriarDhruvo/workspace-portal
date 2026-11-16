"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentKind } from "@portal/db";
import { signOut } from "@/lib/actions/auth";
import { preselectedAgent, soleAgent } from "@/lib/agent-choice";
import { agentFrameUrl, type AgentFrame } from "@/lib/agent-url";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { stopReasonText } from "@/lib/format";
import type { ApiError, StartRequest, WorkspaceStatusResponse } from "@/lib/gateway-types";
import { Brand, UserChip } from "@/components/brand";
import { BarMenu } from "@/components/common/bar-menu";
import { StatusDot, type DotTone } from "@/components/common/status-dot";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { CloseIcon, EyeIcon, KeyIcon, LogOutIcon, ShieldIcon, SwitchIcon, WarningIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { AgentChooser } from "./agent-chooser";
import { BootScreen } from "./boot-screen";
import { StateCard } from "./state-card";
import { SwitchAgentDialog } from "./switch-agent-dialog";

// The /workspace page body: a slim 46px top bar and the workspace's agent (Qwen Code or DeepSeek Harness) in
// an iframe, served by the gateway on the workspace's own port (AGENT_PORT_BASE + user id). It polls
// /api/workspace/status (2 s until ready, then 10 s) and only mounts the iframe once the agent is ready.
// A workspace runs one agent at a time. When nothing runs, the page offers the agents to choose from; with a
// single agent enabled it starts that one by itself. "Switch agent" stops the user's workspace and offers the
// choice again.
// The bar shows in full from the `bar` breakpoint (900px, app/globals.css). Below it, a menu button
// (BarMenu) holds the controls: the bar keeps the mark, the status and "Admin connected".

interface WorkspaceShellProps {
  viewer: { name: string; initials: string; isAdmin: boolean };
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
  /** The agent this page last asked to start: after a failed start, the retry and the chooser's selection. */
  requested: AgentKind | null;
  /**
   * Seen starting or running since the page loaded, so a later "stopped" means it was stopped on us. Reset
   * when the user stops it to switch agents: what follows is a fresh choice.
   */
  active: boolean;
  /** Why the page shows another agent than the one asked for (`agent_mismatch`), until dismissed. */
  notice: string | null;
}

type Action =
  | { type: "status"; info: WorkspaceStatusResponse }
  | { type: "pollFailed"; error: ApiError }
  | { type: "startRequested"; agent: AgentKind }
  | { type: "startSucceeded"; info: WorkspaceStatusResponse }
  | { type: "startFailed"; error: ApiError }
  | { type: "startConflicted"; message: string }
  | { type: "stoppedToSwitch"; info: WorkspaceStatusResponse }
  | { type: "noticeDismissed" };

const INITIAL: State = {
  info: null,
  pollError: null,
  starting: false,
  startError: null,
  requested: null,
  active: false,
  notice: null,
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
      return { ...state, starting: true, startError: null, requested: action.agent, notice: null };
    case "startSucceeded":
      return { ...state, starting: false, info: action.info, pollError: null, active: true };
    case "startFailed":
      return { ...state, starting: false, startError: action.error };
    case "startConflicted":
      // Another tab or device started the other agent first. The view we have is stale: wait for the next
      // poll, then attach to the agent that runs.
      return { ...state, starting: false, info: null, active: true, notice: action.message };
    case "stoppedToSwitch":
      return { ...state, info: action.info, pollError: null, startError: null, active: false, notice: null };
    case "noticeDismissed":
      return { ...state, notice: null };
  }
}

/** Nothing runs in the workspace: it needs a start, of the only agent or of the one the person chooses. */
type Idle =
  /** On arrival, or after the user stopped it to switch agents. */
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
  | { kind: "idle"; idle: Idle; info: WorkspaceStatusResponse }
  | { kind: "unreachable"; message: string }
  | { kind: "switched" };

const UNREACHABLE = new Set(["unreachable", "network"]);

function phaseOf(state: State, targetId: number): Phase {
  const { info } = state;
  if (info && info.targetUserId !== targetId) return { kind: "switched" };
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
    const idle: Idle =
      state.startError.error === "capacity" ? { kind: "capacity" } : { kind: "failed", message: state.startError.message };
    return { kind: "idle", idle, info };
  }
  switch (info.status) {
    case "starting":
    case "running":
      return { kind: "starting" };
    case "stopping":
      return { kind: "stopping" };
    case "error":
      return { kind: "idle", idle: { kind: "failed", message: info.lastError }, info };
    case "stopped":
      if (state.active) return { kind: "idle", idle: { kind: "stopped", reason: info.stopReason }, info };
      // Arriving at a stopped workspace: with a single agent it starts by itself, otherwise the person chooses.
      return soleAgent(info.agents) ? { kind: "starting" } : { kind: "idle", idle: { kind: "fresh" }, info };
  }
}

function pillOf(phase: Phase, pollFailed: boolean): { tone: DotTone; label: string } {
  switch (phase.kind) {
    case "ready":
      return pollFailed ? { tone: "danger", label: "Error" } : { tone: "success", label: "Running" };
    case "connecting":
    case "starting":
      return { tone: "warning", label: "Starting" };
    case "stopping":
      return { tone: "warning", label: "Stopping" };
    case "switched":
      return { tone: "idle", label: "Stopped" };
    case "idle":
      return phase.idle.kind === "fresh" || phase.idle.kind === "stopped"
        ? { tone: "idle", label: "Stopped" }
        : { tone: "danger", label: "Error" };
    case "unreachable":
      return { tone: "danger", label: "Error" };
  }
}

/** The status pill's badge tone for each dot tone (a stopped workspace reads neutral). */
const PILL_VARIANTS = {
  success: "success",
  warning: "warning",
  danger: "danger",
  idle: "neutral",
} as const satisfies Record<DotTone, string>;

/** What "Admin connected" means, for the pill's tooltip and the menu below `bar`. */
const ADMIN_CONNECTED = "An administrator has your workspace open";

/** What a not-running workspace says, whether it then offers a button (one agent) or the agents to choose from. */
function idleCopy(
  idle: Idle,
  target: WorkspaceShellProps["target"],
  idleTimeoutMinutes: number,
): { title: string; body: ReactNode; warning: boolean; action: string } {
  switch (idle.kind) {
    case "fresh":
      return {
        title: target.isViewer ? "Choose an agent" : `Choose an agent for ${target.name}'s workspace`,
        body: target.isViewer
          ? "Your workspace runs one agent at a time. You can switch later from the top bar."
          : "The workspace runs one agent at a time.",
        warning: false,
        action: "Start",
      };
    case "stopped": {
      const reason = stopReasonText(idle.reason, idleTimeoutMinutes);
      return {
        title: target.isViewer ? "Your workspace was stopped" : `${target.name}'s workspace was stopped`,
        body: `${reason ? `It was stopped ${reason}. ` : ""}Files in the workspace are kept.`,
        warning: false,
        action: "Start again",
      };
    }
    case "capacity":
      return {
        title: "Workspace can't start yet",
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
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [pollRound, pollNow] = useReducer((n: number) => n + 1, 0);
  const [switchOpen, setSwitchOpen] = useState(false);
  /** The switch dialog was opened from the menu (below `bar`): the menu button gets the focus back, not the bar's. */
  const [switchFromMenu, setSwitchFromMenu] = useState(false);
  const switchButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const autoStarted = useRef(false);
  const delay = useRef(2_000);

  const { info } = state;
  const phase = phaseOf(state, target.id);
  const switched = phase.kind === "switched";
  const pill = pillOf(phase, state.pollError !== null);
  const running = info?.status === "starting" || info?.status === "running" ? info : null;
  const runningAgent = running?.agent ?? null;
  // Needs window.location, so it is only known in the browser (null while server rendering).
  const agentUrl = useSyncExternalStore(
    noopSubscribe,
    () => (frame && runningAgent ? agentFrameUrl(window.location, frame, runningAgent) : null),
    () => null,
  );
  const adminConnected = !viewer.isAdmin && (info?.connections.admin ?? 0) > 0;
  // One agent at a time: the user can stop theirs to choose again, when there is another to choose.
  const canSwitch = target.isViewer && !switched && !state.starting && running !== null && running.agents.length > 1;

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

  async function start(agent: AgentKind) {
    dispatch({ type: "startRequested", agent });
    pollNow();
    const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent } satisfies StartRequest),
    });
    if (result.ok) dispatch({ type: "startSucceeded", info: result.data });
    else if (needsReauth(result)) router.refresh();
    else if (result.error.error === "agent_mismatch") {
      dispatch({ type: "startConflicted", message: result.error.message });
      pollNow();
    } else dispatch({ type: "startFailed", error: result.error });
  }

  function openSwitch(fromMenu: boolean) {
    setSwitchFromMenu(fromMenu);
    setSwitchOpen(true);
  }

  /** "Switch agent": stops the user's workspace; the page then offers the agents again. */
  async function stopToSwitch(): Promise<string | null> {
    const result = await fetchJson<WorkspaceStatusResponse>("/api/workspace/stop", { method: "POST" });
    if (result.ok) {
      dispatch({ type: "stoppedToSwitch", info: result.data });
      // Restarts polling, which drops an answer still in flight from before the stop.
      pollNow();
      return null;
    }
    if (needsReauth(result)) {
      router.refresh();
      return null;
    }
    return result.error.message;
  }

  // Arriving at a stopped workspace with a single agent enabled (fresh sign-in, or it stopped while away):
  // start it once, as there is nothing to choose.
  const autoStartAgent =
    info?.status === "stopped" &&
    info.targetUserId === target.id &&
    !state.active &&
    !state.starting &&
    state.startError === null
      ? soleAgent(info.agents)
      : null;
  const autoStart = useEffectEvent((agent: AgentKind) => void start(agent));
  useEffect(() => {
    if (!autoStartAgent || autoStarted.current) return;
    autoStarted.current = true;
    autoStart(autoStartAgent);
  }, [autoStartAgent]);

  const whose = target.isViewer ? "your" : `${target.name}'s`;
  let content: ReactNode;
  switch (phase.kind) {
    case "ready":
      content = agentUrl ? (
        <iframe
          src={agentUrl}
          title={`${target.isViewer ? "Your" : `${target.name}'s`} workspace`}
          allow="clipboard-read; clipboard-write; fullscreen"
          className="absolute inset-0 size-full border-0 bg-background"
        />
      ) : frame === null ? (
        <StateCard title="This workspace can't be shown" warning>
          Its account number is beyond the portal&apos;s workspace port range. Ask the administrator to raise
          AGENT_PORT_COUNT.
        </StateCard>
      ) : null;
      break;
    case "connecting":
    case "starting":
      content = <BootScreen hint={`Starting ${whose} workspace…`} />;
      break;
    case "stopping":
      content = <BootScreen hint={`Stopping ${whose} workspace…`} />;
      break;
    case "idle": {
      const copy = idleCopy(phase.idle, target, idleTimeoutMinutes);
      const only = soleAgent(phase.info.agents);
      content = only ? (
        <StateCard title={copy.title} action={{ label: copy.action, onClick: () => start(only) }} warning={copy.warning}>
          {copy.body}
        </StateCard>
      ) : (
        <AgentChooser
          title={copy.title}
          warning={copy.warning}
          agents={phase.info.agents}
          lastAgent={phase.info.agent}
          initialAgent={preselectedAgent(phase.info.agents, state.startError ? state.requested : null, phase.info.agent)}
          onStart={start}
        >
          {copy.body}
        </AgentChooser>
      );
      break;
    }
    case "unreachable": {
      const retry = state.startError ? state.requested : null;
      content = (
        <StateCard
          title="Can't reach the workspace service"
          action={{ label: "Try again", onClick: retry ? () => start(retry) : pollNow }}
          warning
        >
          {phase.message} It may be restarting; this page keeps checking.
        </StateCard>
      );
      break;
    }
    case "switched":
      content = (
        <StateCard title="This page is out of date" action={{ label: "Reload", onClick: () => router.refresh() }}>
          Your session now shows a different workspace, probably from another tab.
        </StateCard>
      );
      break;
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {banner}
      <header className="flex h-11.5 shrink-0 items-center gap-3 border-b bg-background px-5 max-sm:gap-2 max-sm:px-4">
        <Brand compact="bar" />
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        <Badge role="status" aria-label={`Workspace status: ${pill.label}`} variant={PILL_VARIANTS[pill.tone]} size="lg">
          <StatusDot tone={pill.tone} pulse={pill.label === "Starting" || pill.label === "Stopping"} />
          {pill.label}
        </Badge>
        {runningAgent ? (
          <span className="shrink-0 text-13 font-medium text-foreground max-sm:hidden">
            <span className="sr-only">Agent: </span>
            {agentNames[runningAgent]}
          </span>
        ) : null}
        {canSwitch ? (
          <Button
            ref={switchButton}
            type="button"
            variant="ghost"
            size="sm"
            className="max-bar:hidden"
            onClick={() => openSwitch(false)}
          >
            <SwitchIcon />
            Switch agent…
          </Button>
        ) : null}
        {adminConnected ? (
          // On the narrowest phones the label is cut short rather than pushing the menu button off the bar.
          <Badge
            role="status"
            title={ADMIN_CONNECTED}
            variant="warning"
            size="lg"
            className="max-sm:min-w-0 max-sm:shrink"
          >
            <EyeIcon />
            <span className="truncate">Admin connected</span>
          </Badge>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-2 max-bar:hidden">
          {viewer.isAdmin ? (
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin">
                <ShieldIcon />
                Admin
              </Link>
            </Button>
          ) : null}
          <UserChip name={viewer.name} initials={viewer.initials} />
          <Button asChild variant="ghost" size="sm">
            <Link href="/change-password" title="Change your password">
              <KeyIcon />
              Password
            </Link>
          </Button>
          <form action={signOut}>
            <SubmitButton variant="outline" size="sm" icon={<LogOutIcon />}>
              Sign out
            </SubmitButton>
          </form>
        </div>
        <BarMenu ref={menuButton} viewer={viewer} className="ml-auto bar:hidden">
          {runningAgent ? (
            <>
              <DropdownMenuLabel>
                Agent: <span className="text-foreground">{agentNames[runningAgent]}</span>
              </DropdownMenuLabel>
              {canSwitch ? (
                <DropdownMenuItem onSelect={() => openSwitch(true)}>
                  <SwitchIcon />
                  Switch agent…
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {adminConnected ? (
            // The bar's pill may be cut short here, and its tooltip needs a mouse.
            <>
              <DropdownMenuLabel className="flex gap-2 text-warning">
                <EyeIcon className="shrink-0" />
                {ADMIN_CONNECTED}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {viewer.isAdmin ? (
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <ShieldIcon />
                Admin
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem asChild>
            <Link href="/change-password">
              <KeyIcon />
              Change password
            </Link>
          </DropdownMenuItem>
        </BarMenu>
      </header>
      {state.notice ? (
        <div
          role="status"
          className="flex min-h-9 shrink-0 items-center gap-2.5 border-b bg-card px-5 py-1 text-13 text-foreground pointer-coarse:min-h-11"
        >
          <WarningIcon className="shrink-0 text-attention" />
          <span className="min-w-0 flex-1">{state.notice}</span>
          <Button
            type="button"
            variant="muted"
            size="icon"
            aria-label="Dismiss"
            onClick={() => dispatch({ type: "noticeDismissed" })}
          >
            <CloseIcon />
          </Button>
        </div>
      ) : null}
      <main className="relative min-h-0 flex-1">
        {phase.kind === "ready" ? (
          content
        ) : (
          // Centred by auto margins, which keep the top of a card taller than the screen in reach.
          <div className="absolute inset-0 flex overflow-y-auto p-6">
            <div className="m-auto flex w-full justify-center">{content}</div>
          </div>
        )}
      </main>
      {info ? (
        <SwitchAgentDialog
          open={switchOpen}
          onOpenChange={setSwitchOpen}
          info={info}
          onConfirm={stopToSwitch}
          returnFocusTo={switchFromMenu ? menuButton : switchButton}
        />
      ) : null}
    </div>
  );
}
