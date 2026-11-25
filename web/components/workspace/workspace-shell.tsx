"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AGENT_NAMES, WORKSPACE_KIND_NAMES, workspaceOf, type ApiError, type OnlineAccess, type WorkspaceKind, type WorkspaceStatus } from "@portal/core/wire";
import { agentFrameUrl, frameOf, type AgentFrames } from "@/lib/agent-url";
import { needsReauth, startRefusal, startWorkspace, stopWorkspace } from "@/lib/fetch-json";
import { stopReasonText, workspaceState, type WorkspaceState } from "@/lib/format";
import type { WorkspaceStatusResponse } from "@/lib/api";
import type { ActionResult } from "@/lib/validation";
import { hasContainer, initialKind, onlineAccessAfter } from "@/lib/workspace-kind";
import { stopWarnings } from "@/lib/workspace-stop";
import { PortalMark } from "@/components/brand";
import { HOME_LINK, portalLinks } from "@/components/layout/portal-links";
import { NavMenuItems } from "@/components/layout/header-nav";
import { BarMenu } from "@/components/common/bar-menu";
import { useTheme } from "@/components/common/theme";
import { usePoll } from "@/components/common/use-poll";
import { ThemeToggle } from "@/components/common/theme-toggle";
import type { Viewer } from "@/components/layout/app-header";
import { HeaderBar } from "@/components/layout/header-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EyeIcon, HomeIcon, StopIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { BootScreen } from "./boot-screen";
import { KindBadge } from "./kind-badge";
import { PreviewButton } from "./preview-button";
import { KindPicker, StartWorkspaceButton, useKindChoice } from "./start-workspace";
import { StateCard } from "./state-card";
import { StatusPill } from "./status-pill";
import { StopDialog } from "./stop-dialog";

// The /workspace page body: a top bar and the workspace's agent in an iframe, mounted only once the agent is ready.
// Nothing here starts a workspace by itself, and Stop (own workspace only) always asks first.

interface WorkspaceShellProps {
  viewer: Viewer;
  /** Whose workspace this page shows; the gateway routes by the session's target, which must match. */
  target: { id: number; name: string; isViewer: boolean };
  /**
   * The iframe port and token of each of the target's workspaces; null when the user id is outside AGENT_PORT_COUNT
   * (the page explains it).
   */
  frames: AgentFrames;
  idleTimeoutMinutes: number;
  /** Rendered above the top bar (the red-tinted "viewing" banner for admins). */
  banner?: ReactNode;
}

interface State {
  info: WorkspaceStatusResponse | null;
  pollError: ApiError | null;
  /** A start request is in flight. */
  starting: boolean;
  /** The kind the last Start asked for (the bar's badge until the gateway's answer, and what Try again retries). */
  startedKind: WorkspaceKind;
  /** Why the last start was refused, in the portal's words (startErrorText). */
  startError: ApiError | null;
  /** Seen starting or running since the page loaded, so a later "stopped" means it was stopped on us. */
  active: boolean;
  /** The user's own Stop is under way or done: the page shows "Stopping" until Home takes over. */
  leaving: boolean;
}

type Action =
  | { type: "status"; info: WorkspaceStatusResponse }
  | { type: "pollFailed"; error: ApiError }
  | { type: "startRequested"; kind: WorkspaceKind }
  | { type: "startSucceeded"; info: WorkspaceStatusResponse }
  /** `online`: what a refusal for Online access says about it, so the picker shows it unavailable at once. */
  | { type: "startFailed"; error: ApiError; online: OnlineAccess | null }
  | { type: "stopRequested" }
  | { type: "stopFailed" };

const INITIAL: State = {
  info: null,
  pollError: null,
  starting: false,
  startedKind: "private",
  startError: null,
  active: false,
  leaving: false,
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
      return { ...state, starting: true, startedKind: action.kind, startError: null };
    case "startSucceeded":
      return { ...state, starting: false, info: action.info, pollError: null, active: true };
    case "startFailed": {
      const { online } = action;
      return {
        ...state,
        starting: false,
        startError: action.error,
        info: online && state.info ? { ...state.info, online } : state.info,
      };
    }
    case "stopRequested":
      return { ...state, leaving: true };
    case "stopFailed":
      return { ...state, leaving: false };
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

const stateOf = (status: WorkspaceStatus) => workspaceState({ status, ready: false, busy: false });

/** The bar's status pill for each phase. */
function pillOf(phase: Phase, state: State): WorkspaceState {
  switch (phase.kind) {
    case "ready":
      return state.pollError || !state.info ? stateOf("error") : workspaceState(state.info);
    case "connecting":
    case "starting":
      return stateOf("starting");
    case "stopping":
      return stateOf("stopping");
    case "switched":
      return stateOf("stopped");
    case "idle":
      return stateOf(phase.idle.kind === "fresh" || phase.idle.kind === "stopped" ? "stopped" : "error");
    case "unreachable":
      return stateOf("error");
  }
}

/** What "Admin connected" means, for the pill's tooltip and the menu. */
const ADMIN_CONNECTED = "An administrator has your workspace open";

/** "Your", or the owner's name with "'s" for an administrator viewing someone else's workspace. */
function whoseOf(target: WorkspaceShellProps["target"]): string {
  return target.isViewer ? "Your" : `${target.name}'s`;
}

/**
 * What a not-running workspace says (a body only when there is something to explain), and what its Start button
 * is called. `kind`: the one stopped or refused.
 */
function idleCopy(
  idle: Idle,
  target: WorkspaceShellProps["target"],
  kind: WorkspaceKind,
  idleTimeoutMinutes: number,
): { title: string; body: string | null; warning: boolean; retry: boolean } {
  const whose = whoseOf(target);
  switch (idle.kind) {
    case "fresh":
      return { title: `${whose} workspace is stopped`, body: null, warning: false, retry: false };
    case "stopped": {
      const reason = stopReasonText(idle.reason, idleTimeoutMinutes, target.isViewer ? "owner" : "other");
      return {
        title: `${whose} ${WORKSPACE_KIND_NAMES[kind]} workspace was stopped`,
        body: reason ? `It was stopped ${reason}.` : null,
        warning: false,
        retry: false,
      };
    }
    case "capacity":
      return {
        title: "The workspace can't start yet",
        body: "All workspace slots are busy. Try again in a minute.",
        warning: true,
        retry: true,
      };
    case "failed":
      return {
        title: `The ${WORKSPACE_KIND_NAMES[kind]} workspace couldn't start`,
        body: idle.message ?? "Something went wrong while starting it.",
        warning: true,
        retry: true,
      };
  }
}

const noopSubscribe = () => () => {};

export function WorkspaceShell({ viewer, target, frames, idleTimeoutMinutes, banner }: WorkspaceShellProps) {
  const router = useRouter();
  const theme = useTheme();
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [pollRound, pollNow] = useReducer((n: number) => n + 1, 0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const stopButton = useRef<HTMLButtonElement>(null);

  const { info } = state;
  const choice = useKindChoice(info?.online ?? "off", state.startError ? state.startedKind : info ? initialKind(info) : "private");
  const phase = phaseOf(state, target.id);
  const switched = phase.kind === "switched";
  const pill = pillOf(phase, state);
  const running = info?.status === "starting" || info?.status === "running" ? info : null;
  // The iframe is the running workspace's: its own port, so its own browser origin.
  const workspace = running ? workspaceOf(running) : null;
  const frame = workspace ? frameOf(frames, workspace) : null;
  // The kind in the bar while a container is there (or a start was just asked for).
  const shownKind = switched ? null : state.starting ? state.startedKind : info && hasContainer(info.status) ? info.kind : null;
  // Needs window.location, so it is only known in the browser (null while server rendering).
  const agentUrl = useSyncExternalStore(
    noopSubscribe,
    () => (frame && workspace ? agentFrameUrl(window.location, frame, workspace.agent, theme) : null),
    () => null,
  );
  const adminConnected = target.isViewer && (info?.connections.admin ?? 0) > 0;
  // Only the owner stops their workspace here; an admin viewing it has Exit (and the console's Stop).
  const canStop = target.isViewer && running !== null && !state.leaving;
  const warnings = info ? stopWarnings(info, true) : null;
  const whose = target.isViewer ? "your" : `${target.name}'s`;

  usePoll<WorkspaceStatusResponse>(
    switched ? null : "/api/workspace/status",
    phase.kind === "connecting" || phase.kind === "starting" || phase.kind === "stopping" ? 2_000 : 10_000,
    (result) => dispatch(result.ok ? { type: "status", info: result.data } : { type: "pollFailed", error: result.error }),
    pollRound,
  );

  /** Starts that kind (the one chosen in the card, or retried after the service couldn't be reached). */
  async function start(kind: WorkspaceKind) {
    dispatch({ type: "startRequested", kind });
    pollNow();
    const result = await startWorkspace(kind);
    if (result.ok) dispatch({ type: "startSucceeded", info: result.data });
    else if (needsReauth(result)) router.refresh();
    else {
      const refusal = await startRefusal(result.error, whoseOf(target));
      dispatch({ type: "startFailed", error: { ...result.error, message: refusal.message }, online: onlineAccessAfter(result.error) });
      if (refusal.info) dispatch({ type: "status", info: refusal.info });
    }
  }

  /** Stops the user's workspace, then goes Home. */
  async function stop(): Promise<ActionResult> {
    dispatch({ type: "stopRequested" });
    const result = await stopWorkspace();
    if (result.ok) router.push("/");
    else if (needsReauth(result)) router.refresh();
    else {
      dispatch({ type: "stopFailed" });
      return { ok: false, message: result.error.message };
    }
    return { ok: true };
  }

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
          title={`${whoseOf(target)} workspace`}
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
      content = <BootScreen hint={`Starting ${whose} workspace…`} />;
      break;
    case "stopping":
      content = <BootScreen hint={`Stopping ${whose} workspace…`} />;
      break;
    case "idle": {
      const kind = state.startError ? state.startedKind : (info?.kind ?? "private");
      const copy = idleCopy(phase.idle, target, kind, idleTimeoutMinutes);
      content = (
        <StateCard
          title={copy.title}
          warning={copy.warning}
          actions={
            <>
              {/* Apart from Start; under it when a phone has no room. */}
              {home ? <div className="mr-auto max-sm:order-last">{home}</div> : null}
              {info ? <StartWorkspaceButton kind={choice.kind} retry={copy.retry} disabled={info.nextAgent === null} onStart={start} /> : null}
            </>
          }
          body={
            info && info.nextAgent !== null ? (
              <KindPicker value={choice.kind} onValueChange={choice.choose} onlineBlocked={choice.onlineBlocked} idPrefix="workspace-kind" />
            ) : null
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
              <Button type="button" onClick={state.startError ? () => void start(state.startedKind) : pollNow}>
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
      <HeaderBar>
        <Link
          href={target.isViewer ? "/" : "/admin"}
          aria-label={target.isViewer ? "Home" : "Usage"}
          className="hit-area relative shrink-0 rounded-sm"
        >
          <PortalMark />
        </Link>
        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
        {/*
          On a phone the badges keep only their icons and the state's label is cut short, rather than the buttons
          being pushed off the bar.
        */}
        <div className="flex min-w-0 items-center gap-3 overflow-hidden max-sm:gap-2">
          <StatusPill state={pill} className="min-w-0 shrink" />
          {shownKind ? <KindBadge kind={shownKind} compact /> : null}
          {adminConnected ? (
            <Badge role="status" title={ADMIN_CONNECTED} variant="warning">
              <EyeIcon />
              <span className="max-sm:sr-only">Admin connected</span>
            </Badge>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <PreviewButton />
          {canStop ? (
            // Only its icon on phones, as icon-sm's square.
            <Button
              ref={stopButton}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              className="max-sm:w-7 max-sm:px-0"
            >
              <StopIcon />
              <span className="max-sm:sr-only">Stop</span>
            </Button>
          ) : state.leaving ? (
            <Button type="button" variant="outline" size="sm" disabled aria-busy className="max-sm:w-7 max-sm:px-0">
              <Spinner aria-hidden="true" />
              <span className="max-sm:sr-only">Stopping…</span>
            </Button>
          ) : null}
          <ThemeToggle />
          <BarMenu viewer={viewer} trigger="avatar">
            {workspace ? (
              <DropdownMenuLabel>
                Harness: <span className="text-foreground">{AGENT_NAMES[workspace.agent]}</span>
              </DropdownMenuLabel>
            ) : null}
            {adminConnected ? (
              // On a phone the bar's badge is only an eye, and its tooltip needs a mouse.
              <DropdownMenuLabel className="flex gap-2 text-warning">
                <EyeIcon className="shrink-0" />
                {ADMIN_CONNECTED}
              </DropdownMenuLabel>
            ) : null}
            {workspace || adminConnected ? <DropdownMenuSeparator /> : null}
            <NavMenuItems links={[HOME_LINK, ...portalLinks(viewer.isAdmin)]} />
          </BarMenu>
        </div>
      </HeaderBar>
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
