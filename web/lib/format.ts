// Display formatting shared by server and client components. Pure; unit tested.
import type { AgentKind } from "@portal/db";
import type { WorkspaceInfo } from "./gateway-types.ts";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Compact duration: "45s", "12m", "3h 5m", "2d 4h". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago"; older than 30 days returns null (show a date). */
export function formatRelative(at: number, now: number): string | null {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days <= 30) return `${days} days ago`;
  return null;
}

/** Initials for an avatar: first letters of the first and last name. */
export function initials(firstName: string, lastName: string): string {
  const first = [...firstName.trim()][0] ?? "";
  const last = [...lastName.trim()][0] ?? "";
  return (first + last).toLocaleUpperCase();
}

/** Plain-words reason for a stopped workspace, completing "Your workspace was stopped …". */
export function stopReasonText(reason: string | null, idleTimeoutMinutes: number): string | null {
  switch (reason) {
    case "idle":
      return `after ${idleTimeoutMinutes} ${idleTimeoutMinutes === 1 ? "minute" : "minutes"} without activity`;
    case "admin":
      return "by the administrator";
    case "user":
      return "to switch agents";
    case "deactivated":
      return "because the account was deactivated";
    case "capacity":
      return "to free resources";
    case "logout":
      return "because you signed out";
    case "error":
      return "because it ran into an error";
    default:
      return null;
  }
}

/** An agent's version for display: "0.27.0" becomes "v0.27.0"; anything else is shown as it is. */
export function formatVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

/**
 * The workspace's agent in a few words: its name while a container runs it, "last: <name>" once stopped, null
 * if it never started. `names` is AGENT_NAMES (passed in, as client components can't import @portal/db values).
 */
export function agentLabel(
  info: Pick<WorkspaceInfo, "status" | "agent"> | null,
  names: Readonly<Record<AgentKind, string>>,
): string | null {
  if (!info?.agent) return null;
  const name = names[info.agent];
  return info.status === "stopped" || info.status === "error" ? `last: ${name}` : name;
}

function busyText(reason: WorkspaceInfo["busyReason"]): string {
  switch (reason) {
    case "task":
      return "task running";
    case "llm":
      return "waiting on the model";
    case "cpu":
      return "using CPU";
    default:
      return "working";
  }
}

export interface WorkspaceSummary {
  tone: "success" | "warning" | "danger" | "idle";
  label: string;
  /** Extra facts shown after the label ("idle 12m · 412 MiB"). */
  detail: string | null;
  /** Longer explanation for a tooltip (stop reason, last error). */
  title: string | null;
}

/** One-line workspace status for tables. `info` null = the user has no workspace row (stopped). */
export function summarizeWorkspace(info: WorkspaceInfo | null, idleTimeoutMinutes: number): WorkspaceSummary {
  if (!info || info.status === "stopped") {
    const reason = info ? stopReasonText(info.stopReason, idleTimeoutMinutes) : null;
    return { tone: "idle", label: "Stopped", detail: null, title: reason ? `Stopped ${reason}` : null };
  }
  switch (info.status) {
    case "running": {
      if (!info.ready) return { tone: "warning", label: "Starting", detail: null, title: null };
      const parts: string[] = [];
      if (info.busy) parts.push(busyText(info.busyReason));
      else if (info.idleSeconds !== null) parts.push(info.idleSeconds < 60 ? "active" : `idle ${formatDuration(info.idleSeconds)}`);
      if (info.stopPending) parts.push("stops when done");
      if (info.memoryBytes !== null) parts.push(formatBytes(info.memoryBytes));
      if (info.connections.admin > 0) parts.push("admin connected");
      return {
        tone: "success",
        label: info.busy ? "Working" : "Running",
        detail: parts.join(" · ") || null,
        title: info.stopPending ? "Everyone signed out while the agent was working; it stops once the work is done." : null,
      };
    }
    case "starting":
      return { tone: "warning", label: "Starting", detail: null, title: null };
    case "stopping":
      return { tone: "warning", label: "Stopping", detail: null, title: null };
    case "error":
      return { tone: "danger", label: "Error", detail: null, title: info.lastError };
  }
}
