"use client";

import { useCallback, useSyncExternalStore } from "react";

// The gateway shows its last finished job until it restarts; once the admin has read the outcome, this browser
// stops showing it. Only the latest dismissal is kept: a newer job has another id and shows again.

const KEY = "portal.admin.agents.dismissedJob";
const listeners = new Set<() => void>();
/** The dismissal for this page's lifetime, should the browser refuse storage (private mode). */
let dismissedHere: string | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY) ?? dismissedHere;
  } catch {
    return dismissedHere;
  }
}

/**
 * The id of the job dismissed in this browser, and a way to dismiss one. undefined until hydrated (the server
 * can't know), so a dismissed outcome never flashes up on load.
 */
export function useDismissedJob(): [string | null | undefined, (jobId: string) => void] {
  const dismissed = useSyncExternalStore<string | null | undefined>(subscribe, read, () => undefined);
  const dismiss = useCallback((jobId: string) => {
    dismissedHere = jobId;
    try {
      localStorage.setItem(KEY, jobId);
    } catch {
      // Storage refused: dismissed until the page reloads.
    }
    for (const listener of listeners) listener();
  }, []);
  return [dismissed, dismiss];
}
