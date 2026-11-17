"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import type { ApiError } from "@portal/core/wire";

export interface Polled<T> {
  data: T;
  /** A refresh (a POST: the gateway asks its registries again) is under way. */
  refreshing: boolean;
  /** Polls at once: after an action, to show its effect without waiting for the timer. */
  pollNow: () => void;
  /** POSTs to the route (same-origin only): the same answer, fresher. */
  refresh: () => Promise<void>;
}

interface PollOptions<T extends { error: ApiError | null }> {
  /** The JSON route: GET polls, POST refreshes. */
  route: string;
  /** How long until the next poll, from what is on screen. */
  delayOf: (data: T) => number;
  /** A poll's answer; when the gateway can't be reached, the last data stays with the error. */
  merge: (current: T, next: T) => T;
}

/**
 * Live data for an admin page: polls `route` (every delayOf ms, again whenever the window gets the focus back, and
 * at once when asked). Requests run one after another, so an older answer never replaces a newer one. Signed out
 * or no longer an admin (401/403) re-renders the page, which redirects; a failed poll keeps the last data with the
 * error.
 */
export function usePolled<T extends { error: ApiError | null }>(initial: T, { route, delayOf, merge }: PollOptions<T>): Polled<T> {
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
        const result = await fetchJson<T>(route, { method: refresh ? "POST" : "GET", signal });
        if (signal?.aborted) return;
        if (result.ok) setData((current) => merge(current, result.data));
        else if (result.status === 401 || result.status === 403) router.refresh();
        else setData((current) => ({ ...current, error: result.error }));
        setAnswers((count) => count + 1);
      };
      const done = queue.current.then(request);
      queue.current = done.catch(() => undefined);
      return done;
    },
    [route, merge, router],
  );

  const delay = delayOf(data);
  useEffect(() => {
    const timer = setTimeout(() => void load(false), delay);
    return () => clearTimeout(timer);
  }, [delay, answers, load]);

  useEffect(() => {
    const onFocus = () => void load(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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
