// What the workspace page says while a video holds the AI server (WorkspaceInfo.videoHold): why a prompt waits, and
// for how long it may.
import type { VideoHold } from "@portal/core/wire";
import { formatDuration } from "./format.ts";

export interface VideoHoldCopy {
  title: string;
  body: string;
  /** "12m so far, 40% done, about 18m left". */
  progress: string;
  /** The person's own prompt waits: the notice stays until it can run. */
  urgent: boolean;
}

/** The time left, from the share done in the time so far; null until there is enough to go by. */
export function timeLeftSeconds(hold: VideoHold): number | null {
  const { progress, elapsedSeconds } = hold;
  if (progress === null || progress < 5 || progress >= 100) return null;
  return (elapsedSeconds * (100 - progress)) / progress;
}

export function videoHoldCopy(hold: VideoHold): VideoHoldCopy {
  const left = timeLeftSeconds(hold);
  const progress = [
    `${formatDuration(hold.elapsedSeconds)} so far`,
    hold.progress === null ? null : `${Math.round(hold.progress)}% done`,
    left === null ? null : `about ${formatDuration(left)} left`,
  ]
    .filter(Boolean)
    .join(", ");
  if (hold.own) {
    return {
      title: "Your video is being made",
      body: "The AI server makes it alone: every request waits until the video is saved, your agent's other requests too.",
      progress,
      urgent: false,
    };
  }
  if (hold.waiting > 0) {
    return {
      title: "Your request is waiting",
      body: "The AI server is making a video for someone and answers nothing else until it is done. Then your request runs, in the order it was sent.",
      progress,
      urgent: true,
    };
  }
  return {
    title: "The AI server is making a video",
    body: "Prompts you send now wait until it is done, then run in the order they were sent.",
    progress,
    urgent: false,
  };
}
