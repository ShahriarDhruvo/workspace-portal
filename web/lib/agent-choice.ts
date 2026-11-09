// Which agent a workspace starts with. A workspace runs one agent at a time; when nothing runs, the person
// chooses, unless the install enables a single agent. Pure, with type-only imports, so the workspace page can
// use it too; unit tested.
import type { AgentKind } from "@portal/db";
import type { AgentInfo, StartRequest, WorkspaceInfo } from "./gateway-types.ts";

type Offered = readonly Pick<AgentInfo, "id">[];

/** The agent to start without asking: the only one enabled, else null (there is a choice to make). */
export function soleAgent(agents: Offered): AgentKind | null {
  return agents.length === 1 ? (agents[0]?.id ?? null) : null;
}

/**
 * What to ask the gateway when a session starts using a workspace (sign-in, an admin opening it):
 * - starting or running: attach to it (a start without an agent, which also calls off a pending stop);
 * - not running, with a single agent enabled: start that one, since there is nothing to choose;
 * - otherwise nothing: the workspace page lets the person choose.
 */
export function startOnOpen(info: Pick<WorkspaceInfo, "status">, agents: Offered): StartRequest | null {
  if (info.status === "starting" || info.status === "running") return {};
  const agent = soleAgent(agents);
  return agent ? { agent } : null;
}

/**
 * The agent the chooser selects first: the first of `preferred` that is still enabled (the one last started
 * from the page, then the workspace's last agent), else the first one offered.
 */
export function preselectedAgent(agents: Offered, ...preferred: (AgentKind | null)[]): AgentKind | null {
  for (const agent of preferred) {
    if (agent && agents.some((offered) => offered.id === agent)) return agent;
  }
  return agents[0]?.id ?? null;
}
