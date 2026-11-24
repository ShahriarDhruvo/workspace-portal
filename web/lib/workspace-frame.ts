import "server-only";
import { agentBrowserToken, agentPortFor, type SessionContext, type WorkspaceRef } from "@portal/core";
import { framesOf, type AgentFrame, type AgentFrames } from "./agent-url";
import { config } from "./config";

/**
 * The port and token for the iframe of one workspace of the user this session uses (its own, or the one an admin
 * opened): each workspace has its own port, so its own browser origin, and its own token. Null when the user id is
 * beyond AGENT_PORT_COUNT.
 */
function workspaceFrame(session: SessionContext, workspace: WorkspaceRef): AgentFrame | null {
  const port = agentPortFor(config.agentPortBase, config.agentPortCount, session.target.id, workspace);
  if (port === null) return null;
  return { port, token: agentBrowserToken(config.controlSecret, session.session.id, session.target.id, workspace) };
}

/** The frame of every workspace of that user, for the workspace page, which shows the one that runs. */
export function workspaceFrames(session: SessionContext): AgentFrames {
  return framesOf((workspace) => workspaceFrame(session, workspace));
}
