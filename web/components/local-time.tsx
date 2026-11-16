"use client";

import { useSyncExternalStore } from "react";
import { formatRelative } from "@/lib/format";

const noopSubscribe = () => () => {};
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * A timestamp in the viewer's own time zone. The server has no idea which zone that is, so it
 * renders UTC and the browser swaps in local time after hydration. `relative` says how long ago it was (the
 * date alone once that is over a month) and keeps the exact time in a tooltip; a touch screen has no hover, so
 * there the exact time is written out too.
 */
export function LocalTime({ at, relative = false }: { at: number; relative?: boolean }) {
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const date = new Date(at);
  const iso = date.toISOString();
  if (!hydrated) return <time dateTime={iso}>{`${iso.slice(0, 16).replace("T", " ")} UTC`}</time>;
  const full = dateTime.format(date);
  if (!relative) return <time dateTime={iso}>{full}</time>;
  const ago = formatRelative(at, Date.now());
  return (
    <time dateTime={iso} title={full}>
      {ago ? (
        <>
          <span className="whitespace-nowrap">{ago}</span>
          <span className="hidden pointer-coarse:inline"> ({full})</span>
        </>
      ) : (
        <>
          <span className="pointer-coarse:hidden">{dateOnly.format(date)}</span>
          <span className="hidden pointer-coarse:inline">{full}</span>
        </>
      )}
    </time>
  );
}
