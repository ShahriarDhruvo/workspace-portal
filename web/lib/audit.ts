// Human-readable audit log entries.
import { AGENT_NAMES, isAgentKind, isWorkspaceKind, WORKSPACE_KIND_NAMES, workspaceName, type AuditAction, type WorkspaceRef } from "@portal/core";

const ACTION_LABELS: Record<AuditAction, string> = {
  login: "Signed in",
  login_failed: "Failed sign-in",
  logout: "Signed out",
  password_changed: "Changed password",
  user_created: "Created user",
  user_updated: "Updated user",
  password_reset: "Reset password",
  user_deactivated: "Deactivated user",
  user_activated: "Activated user",
  user_deleted: "Deleted user",
  admin_opened_workspace: "Opened workspace",
  admin_exited_workspace: "Left workspace",
  workspace_started: "Workspace started",
  workspace_stopped: "Workspace stopped",
  workspace_error: "Workspace error",
  agent_updated: "Agent updated",
  agent_update_failed: "Agent update failed",
  agent_image_removed: "Agent image removed",
  agent_preference_changed: "Changed harness",
  engine_updated: "LLM engine updated",
  engine_update_failed: "LLM engine update failed",
  engine_image_removed: "LLM engine image removed",
  energy_price_location_set: "Changed electricity price location",
  workspace_files_erased: "Erased workspace files",
  user_online_access_changed: "Changed Online access",
  api_key_created: "Created API key",
  api_key_revoked: "Revoked API key",
};

function isKnownAction(action: string): action is AuditAction {
  return Object.hasOwn(ACTION_LABELS, action);
}

const DETAIL_LABELS: Record<string, string> = {
  username: "Username",
  reason: "Reason",
  role: "Role",
  source: "Source",
  name: "Name",
  firstName: "First name",
  middleName: "Middle name",
  lastName: "Last name",
  error: "Error",
  // Agent updates (written by the gateway) and image removals: agent, from/to or version, rebuild. A harness
  // change (on Home) has from/to as agents.
  agent: "Agent",
  from: "From",
  to: "To",
  version: "Version",
  rebuild: "From scratch",
  // LLM engine updates (written by the gateway) and image removals: from/to or version, rolledBack, digest. A kind
  // (Private or Online) without an agent beside it; with one, the two name a workspace (workspaceIn).
  kind: "Type",
  rolledBack: "Rolled back",
  digest: "Digest",
  // A new user's Online permission, and a change of it.
  onlineAllowed: "Online workspace",
  allowed: "Allowed",
  // The place electricity prices come from, from/to by name.
  location: "Location",
};

function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `workspace_stopped` is written by the gateway: with the admin as actor for Stop/deactivate, without one for
 * idle/logout stops. An update the admin cancelled is written as failed with the error "Cancelled" (agents) or
 * "Cancelled." (the engine): it reads as cancelled.
 */
export function auditActionLabel(action: string, hasActor: boolean, details: string | null = null): string {
  if (action === "workspace_stopped" && hasActor) return "Stopped workspace";
  if ((action === "agent_update_failed" || action === "engine_update_failed") && wasCancelled(details)) {
    return action === "agent_update_failed" ? "Agent update cancelled" : "LLM engine update cancelled";
  }
  return isKnownAction(action) ? ACTION_LABELS[action] : humanize(action);
}

function wasCancelled(details: string | null): boolean {
  try {
    const error = (JSON.parse(details ?? "null") as { error?: unknown } | null)?.error;
    return typeof error === "string" && /^Cancelled\.?$/.test(error);
  } catch {
    return false;
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") {
    const change = value as { from?: unknown; to?: unknown };
    if ("from" in change || "to" in change) return `${formatValue(change.from)} → ${formatValue(change.to)}`;
    return JSON.stringify(value);
  }
  const text = String(value);
  // Codes such as wrong_password read as words; free text (an error naming $DSH_VERSION) stays as written.
  return /^[a-z]+(?:_[a-z]+)+$/.test(text) ? text.replace(/_/g, " ") : text;
}

/** Actions only a signed-in user performs on their own account; a missing actor means the user was deleted. */
const SELF_SERVICE_ACTIONS = new Set(["login", "logout", "password_changed"]);

/** Who to show when an entry has no actor: anonymous sign-in attempts, a since-deleted user, or the
 *  system (the gateway, the admin seed, the reset script). */
export function auditActorFallback(action: string): string {
  if (action === "login_failed") return "—";
  return SELF_SERVICE_ACTIONS.has(action) ? "Deleted user" : "System";
}

/** Keys that hold an agent: `agent`, and from/to of a harness change (an agent update's are versions). */
const AGENT_KEYS = new Set(["agent", "from", "to"]);

/** Agents and workspace kinds by name ("Qwen Code", not "qwen"; "Online"); everything else as formatValue has it. */
function formatDetail(key: string, value: unknown): string {
  if (AGENT_KEYS.has(key) && isAgentKind(value)) return AGENT_NAMES[value];
  if (key === "kind" && isWorkspaceKind(value)) return WORKSPACE_KIND_NAMES[value];
  return formatValue(value);
}

/**
 * The workspace an entry is about: the gateway writes its agent and kind when one starts, stops or fails and when its
 * files are erased. Null for other details (an agent update has no kind, a job's kind names no workspace).
 */
function workspaceIn(details: Record<string, unknown>): WorkspaceRef | null {
  const { agent, kind } = details;
  return isAgentKind(agent) && isWorkspaceKind(kind) ? { agent, kind } : null;
}

/**
 * Renders the JSON `details` column as "Key: value · Key: value". A workspace's agent and kind read as one, its name
 * ("Workspace: Online Qwen Code"), where the agent stands.
 */
export function formatAuditDetails(details: string | null): string {
  if (!details) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return details;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return formatValue(parsed);
  const record = parsed as Record<string, unknown>;
  const workspace = workspaceIn(record);
  return Object.entries(record)
    .flatMap(([key, value]) => {
      if (workspace && key === "kind") return [];
      if (workspace && key === "agent") return [`Workspace: ${workspaceName(workspace)}`];
      return [`${DETAIL_LABELS[key] ?? humanize(key)}: ${formatDetail(key, value)}`];
    })
    .join(" · ");
}

/** The deleted user's name or username, kept in `details` because the target row no longer exists. */
export function auditDetailsSubject(details: string | null): string | null {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details) as { name?: unknown; username?: unknown };
    if (typeof parsed.name === "string") return parsed.name;
    if (typeof parsed.username === "string") return parsed.username;
  } catch {
    // Not JSON: nothing to extract.
  }
  return null;
}
