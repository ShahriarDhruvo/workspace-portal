"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeAgents, pollDelay } from "@/lib/agent-versions";
import { fetchJson } from "@/lib/fetch-json";
import type { AdminAgents } from "@/lib/gateway-types";

const ROUTE = "/api/admin/agents";

export interface AgentVersionsState extends AdminAgents {
  /** A "Check for updates" (a registry refresh) is under way. */
  checking: boolean;
  /** Polls at once: after an action, to show its effect without waiting for the timer. */
  pollNow: () => void;
  /** Asks the npm registry again (the gateway caches release channels for 10 minutes). */
  checkForUpdates: () => Promise<void>;
}

/**
 * The Agents page's live data. Polls GET /api/admin/agents every 2 s while a job builds or verifies, else every
 * 30 s, and at once when asked; "Check for updates" POSTs there instead (a registry refresh, same-origin only).
 * Requests run one after another, so an older answer never replaces a newer one.
 * As on the dashboard: signed out or no longer an admin (401/403) re-renders the page, which redirects; when the
 * gateway can't be reached, the last versions stay on screen with the error.
 */
export function useAgentVersions(initial: AdminAgents): AgentVersionsState {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [checking, setChecking] = useState(false);
  /** Counts answers: each one re-arms the poll timer. */
  const [answers, setAnswers] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => controller.abort();
  }, []);

  const load = useCallback(
    (refresh: boolean) => {
      const request = async () => {
        const signal = mounted.current?.signal;
        if (signal?.aborted) return;
        const result = await fetchJson<AdminAgents>(ROUTE, { method: refresh ? "POST" : "GET", signal });
        if (signal?.aborted) return;
        if (result.ok) setState((current) => mergeAgents(current, result.data));
        else if (result.status === 401 || result.status === 403) router.refresh();
        else setState((current) => ({ ...current, error: result.error }));
        setAnswers((count) => count + 1);
      };
      const done = queue.current.then(request);
      queue.current = done.catch(() => undefined);
      return done;
    },
    [router],
  );

  const delay = pollDelay(state.versions?.job ?? null);
  useEffect(() => {
    const timer = setTimeout(() => void load(false), delay);
    return () => clearTimeout(timer);
  }, [delay, answers, load]);

  const pollNow = useCallback(() => void load(false), [load]);
  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      await load(true);
    } finally {
      setChecking(false);
    }
  }, [load]);

  return { ...state, checking, pollNow, checkForUpdates };
}
