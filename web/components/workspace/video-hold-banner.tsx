"use client";

import { useState } from "react";
import type { VideoHold } from "@portal/core/wire";
import { videoHoldCopy } from "@/lib/video-hold";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CloseIcon, InfoIcon, WarningIcon } from "@/components/ui/icons";
import { Progress } from "@/components/ui/progress";

/**
 * The strip under the workspace's bar while a video holds the AI server: why a prompt gets no answer yet. It can be
 * closed until the person's own prompt waits behind the video; then it stays until that prompt can run.
 */
export function VideoHoldBanner({ hold }: { hold: VideoHold }) {
  const [closed, setClosed] = useState(false);
  const copy = videoHoldCopy(hold);
  if (closed && !copy.urgent) return null;
  const Icon = copy.urgent ? WarningIcon : InfoIcon;
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-5 py-1.5 text-13 max-sm:px-4",
        copy.urgent ? "border-warning/25 bg-warning/10" : "border-info/20 bg-info/8",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 gap-2.5">
        <Icon className={cn("mt-0.5 shrink-0", copy.urgent ? "text-warning" : "text-info")} />
        <span className="min-w-0 wrap-anywhere">
          <span className="font-medium">{copy.title}.</span> {copy.body}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-3 text-muted-foreground tabular-nums">
        {hold.progress !== null ? <Progress value={hold.progress} aria-label="Video progress" className="w-20" /> : null}
        <span>{copy.progress}</span>
        {copy.urgent ? null : (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={() => setClosed(true)}>
            <CloseIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
