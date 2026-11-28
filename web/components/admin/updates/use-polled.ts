"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { mergeLoaded, pollDelay, type Loaded } from "@/lib/update-jobs";
import type { UpdateJob } from "@portal/core/wire";

export interface Polled<T> {
  data: Loaded<T>;
  /** A refresh (a POST: the gateway asks its registries again) is under way. */
  refreshing: boolean;
  /** Polls at once: after an action, to show its effect without waiting for the timer. */
  pollNow: () => void;
  /** POSTs to the route (same-origin only): the same answer, fresher. */
  refresh: () => Promise<void>;
}

/**
 * An updater's overview, live: GETs `route` every second while its job runs, else every 15 s (not while the tab is
 * hidden), again whenever the tab is shown again or the window gets the focus back, and at once when asked; refresh
 * POSTs there. Requests run one after another, so an older answer never replaces a newer one. Signed out or no longer
 * an admin (401/403) re-renders the page, which redirects; a failed poll keeps the last data with the error.
 */
export function usePolled<T extends { job: Pick<UpdateJob<string>, "finishedAt"> | null }>(initial: Loaded<T>, route: string): Polled<T> {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
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
        const result = await fetchJson<Loaded<T>>(route, { method: refresh ? "POST" : "GET", signal });
        if (signal?.aborted) return;
        if (result.ok) setData((current) => mergeLoaded(current, result.data));
        else if (result.status === 401 || result.status === 403) router.refresh();
        else setData((current) => ({ ...current, error: result.error }));
        setAnswers((count) => count + 1);
      };
      const done = queue.current.then(request);
      queue.current = done.catch(() => undefined);
      return done;
    },
    [route, router],
  );

  const delay = pollDelay(data.data?.job ?? null);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!document.hidden) void load(false);
    }, delay);
    return () => clearTimeout(timer);
  }, [delay, answers, load]);

  useEffect(() => {
    const onShown = () => {
      if (!document.hidden) void load(false);
    };
    window.addEventListener("focus", onShown);
    document.addEventListener("visibilitychange", onShown);
    return () => {
      window.removeEventListener("focus", onShown);
      document.removeEventListener("visibilitychange", onShown);
    };
  }, [load]);

  const pollNow = useCallback(() => void load(false), [load]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return { data, refreshing, pollNow, refresh };
}
