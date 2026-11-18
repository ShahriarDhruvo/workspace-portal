"use client";

import { useLayoutEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Within this many pixels of the end counts as "at the bottom": new output keeps it there. */
const FOLLOW_SLACK_PX = 12;

/**
 * The tail of an update's build output, in a scrolling well. It follows new lines while scrolled to the bottom and
 * stays put once the admin scrolls up to read. Not a live region: screen readers hear the phases (the job panel
 * announces them), not every line. The keyboard can focus and scroll it.
 */
export function BuildLog({ lines }: { lines: readonly string[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  function trackScroll() {
    const element = viewport.current;
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
  }

  return (
    <ScrollArea
      className="h-56 w-full rounded-md border bg-muted/50"
      viewportProps={{ ref: viewport, onScroll: trackScroll, tabIndex: 0, role: "region", "aria-label": "Build log" }}
    >
      <pre className="px-3 py-2 font-mono text-12 leading-5 wrap-anywhere whitespace-pre-wrap text-muted-foreground">
        {lines.length > 0 ? lines.join("\n") : "Waiting for build output…"}
      </pre>
    </ScrollArea>
  );
}
