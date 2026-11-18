// Which agent ("harness") a workspace starts with. Each user picks one in Settings (users.agent); a start never
// names an agent, and the gateway launches the user's choice when it is enabled, else the first enabled agent.
// Pure, with type-only imports, so client components can use it too.
import type { AgentInfo, AgentKind } from "@portal/core";

type Offered = readonly Pick<AgentInfo, "id">[];

/**
 * The agent a start launches, as the gateway decides it: the saved choice while it is enabled, else the
 * install's default, the first enabled agent. Null when no agent is enabled.
 */
export function startingAgent(saved: AgentKind | null, enabled: Offered): AgentKind | null {
  if (saved && enabled.some((agent) => agent.id === saved)) return saved;
  return enabled[0]?.id ?? null;
}
