"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useReducer, useRef, useSyncExternalStore, type ReactNode } from "react";
import { signOut } from "@/lib/actions/auth";
import { fetchJson, needsReauth } from "@/lib/fetch-json";
import { agentFrameUrl, type AgentFrame } from "@/lib/agent-url";
import { stopReasonText } from "@/lib/format";
import type { ApiError, WorkspaceStatusResponse } from "@/lib/gateway-types";
import { Brand, PortalMark, UserChip } from "@/components/brand";
import { buttonClass } from "@/components/ui/button";
import { EyeIcon, KeyIcon, LogOutIcon, ShieldIcon, WarningIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { StatusDot, type DotTone } from "@/components/ui/tag";

// The /workspace page body: a slim 46px top bar and the Qwen Code Web Shell in an iframe (served by the
// gateway on the workspace's own port, AGENT_PORT_BASE + user id). It polls /api/workspace/status (2 s until ready, then 10 s), starts the workspace
// when it finds it stopped on arrival, and only mounts the iframe once the Web Shell is ready.

interface WorkspaceShellProps {
  viewer: { name: string; initials: string; isAdmin: boolean };
  /** Whose workspace this page shows; the gateway routes by the session's target, which must match. */
  target: { id: number; name: string; isViewer: boolean };
  /** null when the user id is outside AGENT_PORT_COUNT (the page then explains it). */
  frame: AgentFrame | null;
  idleTimeoutMinutes: number;
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
}

type Action =
  | { type: "status"; info: WorkspaceStatusResponse }
  | { type: "pollFailed"; error: ApiError }
  | { type: "startRequested" }
  | { type: "startSucceeded"; info: WorkspaceStatusResponse }
  | { type: "startFailed"; error: ApiError };

const INITIAL: State = { info: null, pollError: null, starting: false, startError: null, active: false };

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
  }
}

type Phase =
  | { kind: "connecting" }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "stopped"; reason: string | null }
  | { kind: "capacity" }
  | { kind: "failed"; message: string | null }
  | { kind: "unreachable"; message: string }
  | { kind: "switched" };

const UNREACHABLE = new Set(["unreachable", "network"]);

function phaseOf(state: State, targetId: number): Phase {
  const { info } = state;
  if (info && info.targetUserId !== targetId) return { kind: "switched" };
  const ready = info?.status === "running" && info.ready;
  // Keep a working iframe through a failed poll; the Web Shell shows its own connection state.
  if (state.pollError) return ready ? { kind: "ready" } : { kind: "unreachable", message: state.pollError.message };
  if (ready) return { kind: "ready" };
  if (state.starting) return { kind: "starting" };
  if (state.startError) {
    if (state.startError.error === "capacity") return { kind: "capacity" };
    if (UNREACHABLE.has(state.startError.error)) return { kind: "unreachable", message: state.startError.message };
    return { kind: "failed", message: state.startError.message };
  }
  if (!info) return { kind: "connecting" };
  switch (info.status) {
    case "starting":
    case "running":
      return { kind: "starting" };
    case "error":
      return { kind: "failed", message: info.lastError };
    case "stopping":
    case "stopped":
      return state.active ? { kind: "stopped", reason: info.stopReason } : { kind: "starting" };
  }
}

function pillOf(phase: Phase, pollFailed: boolean): { tone: DotTone; label: string } {
  switch (phase.kind) {
    case "ready":
      return pollFailed ? { tone: "danger", label: "Error" } : { tone: "success", label: "Running" };
    case "connecting":
    case "starting":
      return { tone: "warning", label: "Starting" };
    case "stopped":
    case "switched":
      return { tone: "idle", label: "Stopped" };
    default:
      return { tone: "danger", label: "Error" };
  }
}

/** Status pill tones: the tone's text on a 14% tint, like the Web Shell's status badges. */
const PILL_TONES: Record<DotTone, string> = {
  success: "bg-success/14 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-danger/14 text-danger",
  idle: "bg-fg-muted/14 text-fg-muted",
};

const noopSubscribe = () => () => {};

export function WorkspaceShell({ viewer, target, frame, idleTimeoutMinutes, banner }: WorkspaceShellProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [pollRound, pollNow] = useReducer((n: number) => n + 1, 0);
  const autoStarted = useRef(false);
  const delay = useRef(2_000);

  const phase = phaseOf(state, target.id);
  const switched = phase.kind === "switched";
  const pill = pillOf(phase, state.pollError !== null);
  // Needs window.location, so it is only known in the browser (null while server rendering).
  const agentUrl = useSyncExternalStore(
    noopSubscribe,
    () => (frame ? agentFrameUrl(window.location, frame) : null),
    () => null,
  );

  const pollDelay = phase.kind === "connecting" || phase.kind === "starting" ? 2_000 : 10_000;
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
  const autoStart = useEffectEvent(() => void start());

  // Arriving at a stopped workspace (fresh sign-in, or it stopped while away): start it once.
  const shouldAutoStart =
    state.info?.status === "stopped" &&
    state.info.targetUserId === target.id &&
    !state.active &&
    !state.starting &&
    state.startError === null;
  useEffect(() => {
    if (!shouldAutoStart || autoStarted.current) return;
    autoStarted.current = true;
    autoStart();
  }, [shouldAutoStart]);

  const whose = target.isViewer ? "your" : `${target.name}'s`;
  let content: ReactNode;
  switch (phase.kind) {
    case "ready":
      content = agentUrl ? (
        <iframe
          src={agentUrl}
          title={`${target.isViewer ? "Your" : `${target.name}'s`} workspace`}
          allow="clipboard-read; clipboard-write; fullscreen"
          className="absolute inset-0 size-full border-0 bg-base"
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
    case "stopped": {
      const reason = stopReasonText(phase.reason, idleTimeoutMinutes);
      content = (
        <StateCard
          title={target.isViewer ? "Your workspace was stopped" : `${target.name}'s workspace was stopped`}
          action={{ label: "Start again", onClick: start }}
        >
          {reason ? `It was stopped ${reason}. ` : null}Files in the workspace are kept.
        </StateCard>
      );
      break;
    }
    case "capacity":
      content = (
        <StateCard title="Workspace can't start yet" action={{ label: "Try again", onClick: start }} warning>
          All workspace slots are busy. Try again in a minute.
        </StateCard>
      );
      break;
    case "failed":
      content = (
        <StateCard title="The workspace couldn't start" action={{ label: "Try again", onClick: start }} warning>
          {phase.message ?? "Something went wrong while starting it."}
        </StateCard>
      );
      break;
    case "unreachable":
      content = (
        <StateCard
          title="Can't reach the workspace service"
          action={{ label: "Try again", onClick: state.startError ? start : pollNow }}
          warning
        >
          {phase.message} It may be restarting; this page keeps checking.
        </StateCard>
      );
      break;
    case "switched":
      content = (
        <StateCard title="This page is out of date" action={{ label: "Reload", onClick: () => router.refresh() }}>
          Your session now shows a different workspace, probably from another tab.
        </StateCard>
      );
      break;
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-base">
      {banner}
      <header className="flex h-11.5 shrink-0 items-center gap-3 border-b border-line bg-base px-5">
        <Brand />
        <span aria-hidden="true" className="h-4 border-l border-line" />
        <span
          role="status"
          aria-label={`Workspace status: ${pill.label}`}
          className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-12 font-medium ${PILL_TONES[pill.tone]}`}
        >
          <StatusDot tone={pill.tone} pulse={pill.label === "Starting"} />
          {pill.label}
        </span>
        {!viewer.isAdmin && (state.info?.connections.admin ?? 0) > 0 ? (
          <span
            role="status"
            title="An administrator has your workspace open"
            className="inline-flex h-6 items-center gap-1.5 rounded-full bg-warning/14 px-2.5 text-12 font-medium text-warning"
          >
            <EyeIcon size={14} />
            Admin connected
          </span>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {viewer.isAdmin ? (
            <Link href="/admin" className={buttonClass("ghost", "sm")}>
              <ShieldIcon />
              Admin
            </Link>
          ) : null}
          <UserChip name={viewer.name} initials={viewer.initials} />
          <Link href="/change-password" className={buttonClass("ghost", "sm")} title="Change your password">
            <KeyIcon />
            Password
          </Link>
          <form action={signOut}>
            <SubmitButton variant="outline" size="sm" icon={<LogOutIcon />}>
              Sign out
            </SubmitButton>
          </form>
        </div>
      </header>
      <main className="relative min-h-0 flex-1">
        {phase.kind === "ready" ? (
          content
        ) : (
          <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-6">{content}</div>
        )}
      </main>
    </div>
  );
}

/** Boot screen: the portal mark over a Web Shell style loading line (a small ring spinner and muted text). */
function BootScreen({ hint }: { hint: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-5">
      <PortalMark size={36} />
      <span className="flex items-center gap-2 text-13 text-fg-muted">
        <span aria-hidden="true" className="spinner [--spinner-size:14px] [--spinner-width:1.5px]" />
        {hint}
      </span>
    </div>
  );
}

interface StateCardProps {
  title: string;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  warning?: boolean;
}

/** Card for the not-running states, shaped like a Web Shell alert dialog. */
function StateCard({ title, children, action, warning = false }: StateCardProps) {
  return (
    <section role="alert" className="flex w-[min(420px,100%)] flex-col gap-4 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 text-16 leading-snug font-medium">
          {warning ? <WarningIcon className="text-attention" /> : null}
          {title}
        </h2>
        <p className="text-14 text-fg-muted">{children}</p>
      </div>
      {action ? (
        <div className="flex justify-end">
          <button type="button" className={buttonClass("primary", "sm", "min-w-16")} onClick={action.onClick}>
            {action.label}
          </button>
        </div>
      ) : null}
    </section>
  );
}
