"use client";

import { mergeAgents, pollDelay } from "@/lib/agent-versions";
import type { AdminAgents } from "@/lib/gateway-types";
import { usePolled, type Polled } from "./use-polled";

const delayOf = (data: AdminAgents) => pollDelay(data.versions?.job ?? null);

/**
 * The agents' versions, live: GET /api/admin/agents every 1 s while a job builds or verifies, else every 15 s, on
 * focus and when asked; "Check for updates" POSTs there instead (an npm registry refresh, same-origin only).
 */
export function useAgentVersions(initial: AdminAgents): Polled<AdminAgents> {
  return usePolled(initial, { route: "/api/admin/agents", delayOf, merge: mergeAgents });
}
