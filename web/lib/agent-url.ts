// The workspace iframe's address.
import { WORKSPACE_REFS, workspaceIndex, type AgentKind, type WorkspaceRef } from "@portal/core/wire";
import type { Theme } from "./theme.ts";

/** What the server tells the page about a workspace it may show (see lib/workspace-frame.ts). */
export interface AgentFrame {
  /** The gateway port serving this workspace: every workspace has its own, so its own origin. */
  port: number;
  /** This session's token for this workspace (useless without the session cookie). Only Qwen Code's page uses it. */
  token: string;
}

/**
 * The frame of each of one user's workspaces, at the workspace's index (workspaceIndex): the page shows the one that
 * runs, which only the gateway's status names. Null for a user id outside AGENT_PORT_COUNT, whose workspaces have no
 * port.
 */
export type AgentFrames = readonly (AgentFrame | null)[];

/** Every workspace's frame as `frame` gives it, for frameOf to read. */
export function framesOf(frame: (workspace: WorkspaceRef) => AgentFrame | null): AgentFrames {
  return WORKSPACE_REFS.map((workspace) => frame(workspace));
}

/** One workspace's frame among its user's. */
export function frameOf(frames: AgentFrames, workspace: WorkspaceRef): AgentFrame | null {
  return frames[workspaceIndex(workspace)] ?? null;
}

/**
 * src for the workspace iframe, on the workspace's own port and the hostname the user typed (the session cookie is
 * host-scoped). Qwen Code takes the portal's theme (`?theme=`, which beats its saved one) and its session-bound token
 * in the fragment, which never reaches a server; DeepSeek Harness and OpenCode take neither: the gateway adds their
 * credential to every request, and each keeps the theme a person picks in it. OpenCode opens on its own start page:
 * it has an address for a session and for a new session, but none that opens a folder.
 */
export function agentFrameUrl(
  location: Pick<Location, "protocol" | "hostname">,
  frame: AgentFrame,
  agent: AgentKind,
  theme: Theme,
): string {
  const origin = `${location.protocol}//${location.hostname}:${frame.port}`;
  switch (agent) {
    case "qwen":
      return `${origin}/?theme=${theme}#token=${encodeURIComponent(frame.token)}`;
    case "dsh":
    case "opencode":
      return `${origin}/`;
  }
}
