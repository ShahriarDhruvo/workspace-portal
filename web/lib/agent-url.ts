// The workspace iframe's address. Pure; unit tested.
import type { AgentKind } from "@portal/db";

/** What the server tells the page about the workspace it shows (see lib/workspace-frame.ts). */
export interface AgentFrame {
  /** The gateway port serving this workspace: each user's workspace has its own, so its own origin. */
  port: number;
  /** This session's token for this workspace (useless without the session cookie). Only Qwen Code's page uses it. */
  token: string;
}

/**
 * src for the workspace iframe: the web UI of the agent the workspace runs, which the gateway serves on the
 * workspace's own port. Same protocol and hostname the user typed: cookies are host-scoped, so the gateway
 * only sees the portal session when the iframe uses exactly that hostname.
 *
 * - Qwen Code (the Web Shell):
 *   - `?theme=dark`: the Web Shell reads `?theme=` at boot (it beats the shell's own saved choice), so it
 *     always opens in the same dark style as the portal.
 *   - `#token=…`: the Web Shell reads its bearer token from `#token=` (a fragment never reaches a server or a
 *     Referer). It is the session-bound workspace token; the gateway swaps it for the container's real token,
 *     which never leaves the server.
 * - DeepSeek Harness: the root, with no token. dsh authenticates by cookie, which the gateway injects.
 */
export function agentFrameUrl(
  location: Pick<Location, "protocol" | "hostname">,
  frame: AgentFrame,
  agent: AgentKind,
): string {
  const origin = `${location.protocol}//${location.hostname}:${frame.port}`;
  switch (agent) {
    case "qwen":
      return `${origin}/?theme=dark#token=${encodeURIComponent(frame.token)}`;
    case "dsh":
      return `${origin}/`;
  }
}
