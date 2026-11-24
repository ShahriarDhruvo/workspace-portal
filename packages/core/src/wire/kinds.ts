// The values more than one part names: roles, workspace statuses, agents, workspace kinds, a user's workspaces and
// how they are numbered, the two servers, why the web app stops a workspace, the control secret's minimum length.

export const ROLES = ["admin", "user"] as const;

export const WORKSPACE_STATUSES = ["stopped", "starting", "running", "stopping", "error"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/**
 * The agents (harnesses) a workspace can run. Append only: an agent's place in the list numbers its workspaces
 * (workspaceIndex), and so their ports and UIDs.
 */
export const AGENT_KINDS = ["qwen", "dsh", "opencode"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = { qwen: "Qwen Code", dsh: "DeepSeek Harness", opencode: "OpenCode" };

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

/**
 * The two kinds of workspace, which differ in what they reach: Private has no internet; Online reaches the public
 * internet but never the LAN, the servers or another container. Every agent has a workspace of each kind.
 */
export const WORKSPACE_KINDS = ["private", "online"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const WORKSPACE_KIND_NAMES: Readonly<Record<WorkspaceKind, string>> = { private: "Private", online: "Online" };

export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === "string" && (WORKSPACE_KINDS as readonly string[]).includes(value);
}

/**
 * One of a user's workspaces: an agent in a kind. A user has one for every pair, and each is a world of its own: its
 * files, UID, container, browser origins and token are no other workspace's, the same user's others included. All
 * they have in common is the service API (the model, web search, the page reader). One of a user's workspaces runs
 * at a time.
 */
export interface WorkspaceRef {
  readonly agent: AgentKind;
  readonly kind: WorkspaceKind;
}

/** Every workspace a user has, in the order that numbers them (workspaceIndex). */
export const WORKSPACE_REFS: readonly WorkspaceRef[] = AGENT_KINDS.flatMap((agent) => WORKSPACE_KINDS.map((kind) => ({ agent, kind })));

/** A workspace's place among a user's, from 0: agent by agent, each one's Private before its Online. */
export function workspaceIndex(ref: WorkspaceRef): number {
  return AGENT_KINDS.indexOf(ref.agent) * WORKSPACE_KINDS.length + WORKSPACE_KINDS.indexOf(ref.kind);
}

/**
 * A user's workspaces are numbered in a block of this many: one number per workspace, the rest free for agents to
 * come. deploy/lib.sh holds the same number (gateway/src/config.test.ts compares them).
 */
export const WORKSPACE_BLOCK = 20;

/**
 * The number of one of user `userId`'s workspaces, shared with no other workspace of any user. Its ports and its
 * UID are this number above their bases (AGENT_PORT_BASE, WORKSPACE_UID_BASE), so neither moves when an agent is
 * added or the number of users changes.
 */
export function workspaceNumber(userId: number, ref: WorkspaceRef): number {
  return userId * WORKSPACE_BLOCK + workspaceIndex(ref);
}

export function sameWorkspace(a: WorkspaceRef, b: WorkspaceRef): boolean {
  return a.agent === b.agent && a.kind === b.kind;
}

/**
 * The workspace a user's state names (WorkspaceInfo's agent and kind): the one that runs, or ran last. Null before
 * the user's first start.
 */
export function workspaceOf(state: { readonly agent: AgentKind | null; readonly kind: WorkspaceKind }): WorkspaceRef | null {
  return state.agent === null ? null : { agent: state.agent, kind: state.kind };
}

/** A workspace as a sentence names it: "Private Qwen Code", "Online OpenCode". */
export function workspaceName(ref: WorkspaceRef): string {
  return `${WORKSPACE_KIND_NAMES[ref.kind]} ${AGENT_NAMES[ref.agent]}`;
}

/** Why the web app stops a workspace: an admin's Stop, the user's own (to switch agents), deactivation, deletion. */
export const STOP_REASONS = ["admin", "user", "deactivated", "deleted"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** The two servers portal-hostd reports on: the portal's own and the LLM server. */
export const HOST_ROLES = ["portal", "llm"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/** GATEWAY_CONTROL_SECRET: neither the gateway nor the web app starts with a shorter one. */
export const MIN_CONTROL_SECRET_LENGTH = 16;
