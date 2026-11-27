// What the LLM card's generation tile says (LlmLive.generation): the kind being made, or else made last, how many are
// being made, a video's progress, and how long one takes. The image and media servers report no progress of their
// own but a video's, so the rest comes from the portal's record of the requests.
import type { GenerationKind, LlmGeneration } from "@portal/core/wire";
import { formatDuration } from "./format.ts";
import { formatNumber } from "./live-format.ts";

export interface GenerationTileCopy {
  label: string;
  /** The large figure: requests being made, or a video's percent done. */
  figure: string;
  /** After the figure: "in progress", "done". */
  suffix: string;
  /** The small line: the pace, or a video's time so far. */
  detail: string;
  hint: string;
}

const KINDS: Record<GenerationKind, { label: string; one: string; requests: string; unit: string }> = {
  image: { label: "Images", one: "image", requests: "Image requests", unit: "per image" },
  video: { label: "Video", one: "video", requests: "Video jobs", unit: "per video" },
  music: { label: "Music", one: "track", requests: "Music requests", unit: "per track" },
  speech: { label: "Speech", one: "speech request", requests: "Speech requests", unit: "per request" },
  transcription: { label: "Transcription", one: "transcript", requests: "Transcriptions", unit: "per file" },
};

/** "26 s" under 100 seconds, "3m 37s" and "1h 14m" above. */
export function paceText(seconds: number): string {
  if (seconds < 100) return `${formatNumber(seconds)} s`;
  const whole = Math.round(seconds);
  return whole < 3600 ? `${Math.floor(whole / 60)}m ${whole % 60}s` : formatDuration(whole);
}

export function generationTileCopy(generation: LlmGeneration): GenerationTileCopy {
  const { kind, making, model, video, pace } = generation;
  if (kind === null) {
    return { label: "Generation", figure: "0", suffix: "in progress", detail: "nothing made yet", hint: "Images, video, music, speech and transcriptions being made: none since the gateway started" };
  }
  const copy = KINDS[kind];
  const paced = pace ? `${paceText(pace.seconds)} ${copy.unit}` : null;
  const timing =
    kind === "video"
      ? "from its start to its completion"
      : "each from when it could start (not the wait behind other requests) to its answer, a model start included when one was needed";
  const paceHint = pace
    ? `${paced}: the median of the last five on ${pace.model ?? `the ${kind} model`}, ${timing}`
    : `The time ${copy.unit} shows once one has finished`;
  const now = making > 0 ? `${copy.requests} being made now${model ? ` on ${model}` : ""}` : `Nothing being made now; the last was ${kind === "image" ? "an image" : `a ${copy.one}`}`;
  const hint = `${now}. ${paceHint}`;
  if (video !== null) {
    const figure = video.progress === null ? String(making) : `${Math.round(video.progress)}%`;
    const detail = `${formatDuration(video.elapsedSeconds)} so far${pace ? `, about ${paceText(pace.seconds)} each` : ""}`;
    return { label: copy.label, figure, suffix: video.progress === null ? "in progress" : "done", detail, hint };
  }
  return { label: copy.label, figure: String(making), suffix: "in progress", detail: paced ?? `no ${copy.one} yet`, hint };
}
