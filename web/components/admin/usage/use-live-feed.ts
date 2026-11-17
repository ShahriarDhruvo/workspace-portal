"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { EMPTY_HISTORY, historyFromInit, historyWithFrame, type LiveHistory } from "@/lib/live-format";
import type { LiveFrame, LiveInit } from "@portal/core/wire";

const ROUTE = "/api/admin/live";
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** Frames come every 500 ms: an open stream without one for this long has stalled, and is opened again. */
const STALE_MS = 5_000;

/** connecting: the first frame is on its way; live; paused: the tab is hidden; retrying: the stream broke. */
export type LiveStatus = "connecting" | "live" | "paused" | "retrying";

export interface LiveFeed {
  status: LiveStatus;
  frame: LiveFrame | null;
  history: LiveHistory;
  /** Why the stream is down (shown while retrying). */
  error: string | null;
}

/**
 * The Usage page's live data: follows GET /api/admin/live (frames every 500 ms) while the tab is visible. A hidden tab
 * closes the stream, so the gateway and both servers stop measuring when nobody looks. A stream that breaks is
 * opened again after 2 s, doubling to 30 s; one refused because the session is no longer an admin's re-renders the
 * page, which redirects. "Live" means frames arrive: while the browser reconnects a dropped stream, or an open one
 * has sent nothing for STALE_MS, the status is "retrying".
 */
export function useLiveFeed(): LiveFeed {
  const router = useRouter();
  const [feed, setFeed] = useState<LiveFeed>({ status: "connecting", frame: null, history: EMPTY_HISTORY, error: null });

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = RETRY_MIN_MS;
    let disposed = false;
    let lastFrameAt = 0;

    const close = (): void => {
      source?.close();
      source = null;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const open = (): void => {
      close();
      const stream = new EventSource(ROUTE);
      source = stream;
      stream.addEventListener("open", () => {
        lastFrameAt = Date.now();
      });
      stream.addEventListener("init", (event) => {
        const init = JSON.parse((event as MessageEvent<string>).data) as LiveInit;
        setFeed((current) => ({ ...current, history: historyFromInit(init) }));
      });
      stream.addEventListener("frame", (event) => {
        const frame = JSON.parse((event as MessageEvent<string>).data) as LiveFrame;
        retryMs = RETRY_MIN_MS;
        lastFrameAt = Date.now();
        setFeed((current) => ({ status: "live", frame, history: historyWithFrame(current.history, frame), error: null }));
      });
      stream.addEventListener("error", () => {
        if (disposed) return;
        // EventSource retries a dropped connection by itself, but gives up on a refused one (not 200).
        if (stream.readyState === EventSource.CLOSED) void diagnose();
        else setFeed((current) => (current.status === "live" ? { ...current, status: "retrying", error: null } : current));
      });
    };

    const diagnose = async (): Promise<void> => {
      close();
      const check = await fetchJson<unknown>("/api/admin/overview");
      if (disposed) return;
      if (!check.ok && (check.status === 401 || check.status === 403)) {
        router.refresh();
        return;
      }
      const error = check.ok ? "The live view is not available right now." : check.error.message;
      setFeed((current) => ({ ...current, status: "retrying", error }));
      retryTimer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        close();
        setFeed((current) => ({ ...current, status: "paused" }));
      } else if (source === null) {
        setFeed((current) => ({ ...current, status: current.frame ? "connecting" : current.status }));
        open();
      }
    };

    const watchdog = setInterval(() => {
      if (source?.readyState !== EventSource.OPEN || Date.now() - lastFrameAt <= STALE_MS) return;
      setFeed((current) => ({ ...current, status: "retrying", error: null }));
      open();
    }, 1_000);

    if (document.visibilityState === "visible") open();
    else setFeed((current) => ({ ...current, status: "paused" }));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [router]);

  return feed;
}
