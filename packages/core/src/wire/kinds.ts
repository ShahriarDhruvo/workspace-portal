// The values the database, the gateway and the browser all name: roles, workspace statuses, agents, workspace kinds,
// the two servers, why the web app stops a workspace.

export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

export const WORKSPACE_STATUSES = ["stopped", "starting", "running", "stopping", "error"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** The agents a workspace can run. A user's workspace runs one of them at a time. */
export const AGENT_KINDS = ["qwen", "dsh"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = { qwen: "Qwen Code", dsh: "DeepSeek Harness" };

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

/**
 * The two workspaces every user has. Each has its own files, UID, container, network and browser origin, and only
 * one of a user's two runs at a time. Private has no internet; Online reaches the public internet but never the LAN,
 * the servers or another container.
 */
export const WORKSPACE_KINDS = ["private", "online"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const WORKSPACE_KIND_NAMES: Readonly<Record<WorkspaceKind, string>> = { private: "Private", online: "Online" };

export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === "string" && (WORKSPACE_KINDS as readonly string[]).includes(value);
}

/** Why the web app stops a workspace: an admin's Stop, the user's own (to switch agents), deactivation, deletion. */
export const STOP_REASONS = ["admin", "user", "deactivated", "deleted"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** The two servers portal-hostd reports on: the portal's own and the LLM server. */
export const HOST_ROLES = ["portal", "llm"] as const;
export type HostRole = (typeof HOST_ROLES)[number];
