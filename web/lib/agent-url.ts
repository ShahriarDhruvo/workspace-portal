// The workspace iframe's address.
import type { AgentKind } from "@portal/core";
import type { Theme } from "./theme.ts";

/** What the server tells the page about the workspace it shows (see lib/workspace-frame.ts). */
export interface AgentFrame {
  /** The gateway port serving this workspace: each user's workspace has its own, so its own origin. */
  port: number;
  /** This session's token for this workspace (useless without the session cookie). Only Qwen Code's page uses it. */
  token: string;
}

/**
 * src for the workspace iframe, on the workspace's own port and the hostname the user typed (the session cookie is
 * host-scoped). Qwen Code takes the portal's theme (`?theme=`, which beats its saved one) and its session-bound token
 * in the fragment, which never reaches a server; DeepSeek Harness takes neither: the gateway injects its cookie.
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
      return `${origin}/`;
  }
}
