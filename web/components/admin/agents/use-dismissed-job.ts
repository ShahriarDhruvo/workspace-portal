"use client";

import { useCallback, useSyncExternalStore } from "react";

// The gateway shows its last finished job (of the agents, and of the LLM engine) until it restarts; once the admin
// has read the outcome, this browser stops showing it. Only the latest dismissal of each kind is kept: a newer job
// has another id and shows again.

export type DismissedKind = "agents" | "engine";

const KEYS: Record<DismissedKind, string> = {
  agents: "portal.admin.agents.dismissedJob",
  engine: "portal.admin.engine.dismissedJob",
};
const listeners = new Set<() => void>();
/** The dismissals for this page's lifetime, should the browser refuse storage (private mode). */
const dismissedHere: Record<DismissedKind, string | null> = { agents: null, engine: null };

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function read(kind: DismissedKind): string | null {
  try {
    return localStorage.getItem(KEYS[kind]) ?? dismissedHere[kind];
  } catch {
    return dismissedHere[kind];
  }
}

/**
 * The id of the job dismissed in this browser, and a way to dismiss one. undefined until hydrated (the server
 * can't know), so a dismissed outcome never flashes up on load.
 */
export function useDismissedJob(kind: DismissedKind): [string | null | undefined, (jobId: string) => void] {
  const dismissed = useSyncExternalStore<string | null | undefined>(subscribe, () => read(kind), () => undefined);
  const dismiss = useCallback((jobId: string) => {
    dismissedHere[kind] = jobId;
    try {
      localStorage.setItem(KEYS[kind], jobId);
    } catch {
      // Storage refused: dismissed until the page reloads.
    }
    for (const listener of listeners) listener();
  }, [kind]);
  return [dismissed, dismiss];
}
