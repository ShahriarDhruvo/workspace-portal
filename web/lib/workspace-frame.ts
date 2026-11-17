import "server-only";
import { agentBrowserToken, agentPortFor, type SessionContext, type WorkspaceKind } from "@portal/core";
import type { AgentFrame } from "./agent-url";
import { config } from "./config";

/**
 * The port and token for the iframe of one kind of the workspace this session uses (its own, or the one an admin
 * opened): each kind has its own port, so its own browser origin. Null when the user id is beyond AGENT_PORT_COUNT.
 */
export function workspaceFrame(session: SessionContext, kind: WorkspaceKind): AgentFrame | null {
  const base = kind === "online" ? config.onlineAgentPortBase : config.agentPortBase;
  const port = agentPortFor(base, config.agentPortCount, session.target.id);
  if (port === null) return null;
  return { port, token: agentBrowserToken(config.controlSecret, session.session.id, session.target.id, kind) };
}
