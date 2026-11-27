"use client";

import type { AppUpdateJob, EngineUpdateJob } from "@portal/core/wire";
import { cancelAppUpdate, cancelEngineUpdate } from "@/lib/actions/updates";
import { appJobOutcome, appJobStep, appJobTitle, appPhaseLabel } from "@/lib/app-updates";
import { engineJobOutcome, engineJobStep, engineJobTitle, enginePhaseLabel } from "@/lib/engine-updates";
import { drainRunning, isJobActive, type JobStep } from "@/lib/update-jobs";
import type { ActionResult } from "@/lib/validation";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { JobButtons, JobOutcome, JobPanel } from "./version-card";

interface JobProps<Job> {
  job: Job;
  onChanged: () => void;
  /** Opens the "Restart now" confirmation (it cuts running requests off). */
  onRestartNow: (from: HTMLElement) => void;
  onDismiss: () => void;
}

/** Gufo's job, inline in its card. */
export function EngineJob({ job, ...rest }: JobProps<EngineUpdateJob>) {
  return (
    <HostJob
      {...rest}
      job={job}
      words={{ title: engineJobTitle(job), phase: enginePhaseLabel(job), step: engineJobStep(job), outcome: engineJobOutcome(job), subject: "the engine" }}
      cancel={cancelEngineUpdate}
    />
  );
}

/** A program's job (llama-swap, vLLM…), inline in its card. */
export function AppJob({ job, ...rest }: JobProps<AppUpdateJob>) {
  return (
    <HostJob
      {...rest}
      job={job}
      words={{ title: appJobTitle(job), phase: appPhaseLabel(job), step: appJobStep(job), outcome: appJobOutcome(job), subject: job.appName }}
      cancel={cancelAppUpdate}
    />
  );
}

interface HostJobProps extends JobProps<EngineUpdateJob | AppUpdateJob> {
  words: {
    title: string;
    phase: string;
    step: JobStep;
    outcome: string;
    /** What restarts: "the engine", "llama-swap". */
    subject: string;
  };
  cancel: () => Promise<ActionResult>;
}

/**
 * A job through the AI server's portal-hostd: it may download or install first, then holds new requests in the
 * portal's queue while the running ones finish, and restarts. Its panel while it runs, then the outcome until dismissed.
 */
function HostJob({ job, words, cancel, onChanged, onRestartNow, onDismiss }: HostJobProps) {
  if (!isJobActive(job)) {
    return (
      <JobOutcome job={job} title={words.title} onDismiss={onDismiss}>
        {words.outcome}
      </JobOutcome>
    );
  }
  const { step, subject } = words;
  return (
    <JobPanel
      title={words.title}
      phase={`Step ${step.index} of ${step.count} · ${words.phase}`}
      progress={step.progress}
      // While draining, the requests still running say more than the step does.
      step={job.phase === "draining" ? null : job.step}
      startedAt={job.startedAt}
      log={job.log}
      actions={
        job.cancellable || job.phase === "draining" ? (
          <JobButtons cancel={job.cancellable ? cancel : null} onChanged={onChanged}>
            {job.phase === "draining" ? (
              <Button type="button" variant="destructive" size="sm" onClick={(event) => onRestartNow(event.currentTarget)}>
                Restart now…
              </Button>
            ) : null}
          </JobButtons>
        ) : null
      }
    >
      {job.phase === "draining" && job.drain ? (
        <p className="text-13 text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{drainRunning(job.drain)}</span> still running. New requests wait in the portal&apos;s queue; {subject} restarts once these finish, or at{" "}
          <LocalTime at={job.drain.deadline} /> at the latest.
        </p>
      ) : job.phase === "restarting" && job.rolledBack ? (
        <p className="text-13 text-muted-foreground">
          {job.toVersion} didn&apos;t start properly, so the AI server is putting{" "}
          {job.fromVersion ?? "the previous version"} back. New requests keep waiting in the portal&apos;s queue.
        </p>
      ) : job.phase === "restarting" ? (
        <p className="text-13 text-muted-foreground">
          New requests wait in the portal&apos;s queue until the AI server answers again. If the new version doesn&apos;t
          start properly, the AI server puts the previous one back by itself.
        </p>
      ) : null}
    </JobPanel>
  );
}
