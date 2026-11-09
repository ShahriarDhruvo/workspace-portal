"use client";

import { useSyncExternalStore } from "react";
import { formatRelative } from "@/lib/format";

const noopSubscribe = () => () => {};
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * A timestamp in the viewer's own time zone. The server has no idea which zone that is, so it
 * renders UTC and the browser swaps in local time after hydration.
 */
export function LocalTime({ at, relative = false }: { at: number; relative?: boolean }) {
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const date = new Date(at);
  const iso = date.toISOString();
  if (!hydrated) return <time dateTime={iso}>{`${iso.slice(0, 16).replace("T", " ")} UTC`}</time>;
  const full = dateTime.format(date);
  const text = relative ? (formatRelative(at, Date.now()) ?? dateOnly.format(date)) : full;
  return (
    <time dateTime={iso} title={full}>
      {text}
    </time>
  );
}
