"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent } from "react";
import { fetchJson, type FetchResult } from "@/lib/fetch-json";

/**
 * Asks `url` again `delayMs` after each answer and hands the answer to `onAnswer`; with `round`, at once on mount and
 * whenever it changes. Signed out or no longer allowed (401/403): the page re-renders, which redirects, and the
 * asking ends. Off while `url` is null.
 */
export function usePoll<T>(url: string | null, delayMs: number, onAnswer: (result: FetchResult<T>) => void, round?: number): void {
  const router = useRouter();
  const latest = useEffectEvent(() => ({ delayMs, onAnswer }));

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await fetchJson<T>(url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.ok && (result.status === 401 || result.status === 403)) return router.refresh();
      latest().onAnswer(result);
      timer = setTimeout(poll, latest().delayMs);
    };
    if (round === undefined) timer = setTimeout(poll, latest().delayMs);
    else void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, round, router]);
}
