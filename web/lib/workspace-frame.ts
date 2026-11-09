import "server-only";
import { agentBrowserToken, agentPortFor, type SessionContext } from "@portal/db";
import type { AgentFrame } from "./agent-url";
import { config } from "./config";

/**
 * The port and token for the iframe of the workspace this session uses (its own, or the one an
 * admin opened). Null when the user id is beyond AGENT_PORT_COUNT.
 */
export function workspaceFrame(session: SessionContext): AgentFrame | null {
  const port = agentPortFor(config.agentPortBase, config.agentPortCount, session.target.id);
  if (port === null) return null;
  return { port, token: agentBrowserToken(config.controlSecret, session.session.id, session.target.id) };
}
