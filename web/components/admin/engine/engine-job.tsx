"use client";

import { cancelEngineUpdate } from "@/lib/actions/updates";
import type { EngineUpdateJob } from "@portal/core/wire";
import { engineJobOutcome, engineJobStep, engineJobTitle, enginePhaseLabel } from "@/lib/engine-updates";
import { isJobActive } from "@/lib/update-jobs";
import { JobButtons, JobOutcome, JobPanel } from "@/components/admin/agents/version-card";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";

interface EngineJobProps {
  job: EngineUpdateJob;
  /** Something changed: poll now. */
  onChanged: () => void;
  /** Opens the "Restart now" confirmation (it cuts running requests off). */
  onRestartNow: (from: HTMLElement) => void;
  onDismiss: () => void;
}

/**
 * The engine's job, inline in its card. Running: its panel, while draining how many requests still run and until
 * when it waits, Cancel (downloading or draining) and "Restart now" (draining). Finished: the outcome until dismissed.
 */
export function EngineJob({ job, onChanged, onRestartNow, onDismiss }: EngineJobProps) {
  if (!isJobActive(job)) {
    return (
      <JobOutcome job={job} title={engineJobTitle(job)} onDismiss={onDismiss}>
        {engineJobOutcome(job)}
      </JobOutcome>
    );
  }
  const step = engineJobStep(job);
  return (
    <JobPanel
      title={engineJobTitle(job)}
      stage={`Step ${step.index} of ${step.count} · ${enginePhaseLabel(job)}`}
      progress={step.progress}
      // While draining, the requests still running say more than the step does.
      step={job.phase === "draining" ? null : job.step}
      startedAt={job.startedAt}
      log={job.log}
      actions={
        job.cancellable || job.phase === "draining" ? (
          <JobButtons cancel={job.cancellable ? cancelEngineUpdate : null} onChanged={onChanged}>
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
          <span className="font-medium text-foreground tabular-nums">
            {job.drain.inFlight} {job.drain.inFlight === 1 ? "request" : "requests"}
          </span>{" "}
          still running. New requests wait in the portal&apos;s queue; the engine restarts once these finish, or at{" "}
          <LocalTime at={job.drain.deadline} /> at the latest.
        </p>
      ) : job.phase === "restarting" && job.rolledBack ? (
        <p className="text-13 text-muted-foreground">
          {job.toVersion} didn&apos;t start properly, so the LLM server is putting {job.fromVersion ?? "the previous version"} back. New
          requests keep waiting in the portal&apos;s queue.
        </p>
      ) : job.phase === "restarting" ? (
        <p className="text-13 text-muted-foreground">
          New requests wait in the portal&apos;s queue until the engine answers again. If the new version doesn&apos;t start properly, the
          LLM server puts the previous one back by itself.
        </p>
      ) : null}
    </JobPanel>
  );
}
