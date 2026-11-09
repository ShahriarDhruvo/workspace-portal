// Human-readable audit log entries. Pure; unit tested.

const ACTION_LABELS: Record<string, string> = {
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
  workspace_error: "Workspace error",
};

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
};

function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `workspace_stopped` is written by the gateway: with the admin as actor for Stop/deactivate, without one for idle/logout stops. */
export function auditActionLabel(action: string, hasActor: boolean): string {
  if (action === "workspace_stopped") return hasActor ? "Stopped workspace" : "Workspace stopped";
  return ACTION_LABELS[action] ?? humanize(action);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") {
    const change = value as { from?: unknown; to?: unknown };
    if ("from" in change || "to" in change) return `${formatValue(change.from)} → ${formatValue(change.to)}`;
    return JSON.stringify(value);
  }
  return String(value).replace(/_/g, " ");
}

/** Actions only a signed-in user performs on their own account; a missing actor means the user was deleted. */
const SELF_SERVICE_ACTIONS = new Set(["login", "logout", "password_changed"]);

/** Who to show when an entry has no actor: anonymous sign-in attempts, a since-deleted user, or the
 *  system (the gateway, the admin seed, the reset script). */
export function auditActorFallback(action: string): string {
  if (action === "login_failed") return "—";
  return SELF_SERVICE_ACTIONS.has(action) ? "Deleted user" : "System";
}

/** Renders the JSON `details` column as "Key: value · Key: value". */
export function formatAuditDetails(details: string | null): string {
  if (!details) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return details;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return formatValue(parsed);
  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => `${DETAIL_LABELS[key] ?? humanize(key)}: ${formatValue(value)}`)
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
