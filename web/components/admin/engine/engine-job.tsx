"use client";

import { useState, useTransition } from "react";
import { cancelEngineUpdate } from "@/lib/actions/engine";
import type { EngineUpdateJob } from "@portal/core/wire";
import { engineJobOutcome, engineJobStep, engineJobTitle, engineStageLabel, isEngineJobActive } from "@/lib/engine-updates";
import { FormError } from "@/components/forms/form-error";
import { JobOutcome, JobPanel } from "@/components/admin/agents/version-card";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface EngineJobProps {
  job: EngineUpdateJob;
  /** Something changed: poll now. */
  onChanged: () => void;
  /** Opens the "Restart now" confirmation (it cuts running requests off). */
  onRestartNow: (from: HTMLElement) => void;
  onDismiss: () => void;
}

/**
 * The engine's job, inline in its card. Running: the stage on a Progress, the step, while draining how many requests
 * still run and until when it waits, Cancel (downloading or draining) and "Restart now" (draining); the log on
 * request. Finished: the outcome until dismissed.
 */
export function EngineJob({ job, onChanged, onRestartNow, onDismiss }: EngineJobProps) {
  if (!isEngineJobActive(job)) {
    const outcome = job.phase === "succeeded" ? "succeeded" : job.phase === "cancelled" ? "cancelled" : "failed";
    return (
      <JobOutcome
        outcome={outcome}
        title={engineJobTitle(job)}
        error={outcome === "failed" ? job.error : null}
        log={job.log}
        onDismiss={onDismiss}
      >
        {engineJobOutcome(job)}
      </JobOutcome>
    );
  }
  const step = engineJobStep(job);
  return (
    <JobPanel
      title={engineJobTitle(job)}
      stage={`Step ${step.index} of ${step.count} · ${engineStageLabel(job)}`}
      progress={step.progress}
      // While draining, the requests still running say more than the step does.
      step={job.phase === "draining" ? null : job.step}
      startedAt={job.startedAt}
      log={job.log}
      actions={<JobButtons job={job} onChanged={onChanged} onRestartNow={onRestartNow} />}
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
          {job.toVersion ?? "The new version"} didn&apos;t start properly, so the LLM server is putting{" "}
          {job.fromVersion ?? "the previous version"} back. New requests keep waiting in the portal&apos;s queue.
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

function JobButtons({ job, onChanged, onRestartNow }: Omit<EngineJobProps, "onDismiss">) {
  const [cancelling, startCancel] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!job.cancellable && job.phase !== "draining") return null;
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {job.cancellable ? (
          // Not disabled while cancelling, so the focus stays on it; a second press changes nothing.
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={cancelling || undefined}
            aria-busy={cancelling || undefined}
            onClick={() => {
              if (cancelling) return;
              setError(null);
              startCancel(async () => {
                const result = await cancelEngineUpdate();
                if (!result.ok) setError(result.message);
                onChanged();
              });
            }}
          >
            {cancelling ? <Spinner aria-hidden="true" /> : null}
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        ) : null}
        {job.phase === "draining" ? (
          <Button type="button" variant="destructive" size="sm" onClick={(event) => onRestartNow(event.currentTarget)}>
            Restart now…
          </Button>
        ) : null}
      </div>
      {error ? <FormError>{error}</FormError> : null}
    </div>
  );
}
