"use client";

import type { AdminEngine } from "@/lib/engine-types";
import { enginePollDelay, mergeEngine } from "@/lib/engine-updates";
import { usePolled, type Polled } from "@/components/admin/agents/use-polled";

const delayOf = (data: AdminEngine) => enginePollDelay(data.engine?.job ?? null);

/**
 * The LLM engine, live: GET /api/admin/engine every 1 s while a job runs, else every 15 s, on focus and when asked;
 * "Check for updates" POSTs there instead (the image registry and GitHub asked again, same-origin only).
 */
export function useEngine(initial: AdminEngine): Polled<AdminEngine> {
  return usePolled(initial, { route: "/api/admin/engine", delayOf, merge: mergeEngine });
}
