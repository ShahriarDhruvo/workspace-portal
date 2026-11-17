"use client";

import { startTransition, useActionState, useEffect, useEffectEvent, type RefObject } from "react";
import { cancelAgentUpdate, type AgentActionState } from "@/lib/actions/agents";
import { agentJobStep, formatElapsed, isJobActive, jobElapsedMs, jobOutcome, jobTitle, phaseLabel } from "@/lib/agent-versions";
import type { AgentUpdateJob, AgentVersionInfo } from "@portal/core/wire";
import { FormError } from "@/components/forms/form-error";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { JobOutcome, JobPanel } from "./version-card";

// The agents' update job, inline in its agent's card: while it runs, its step on a Progress, the current build step,
// the log on request and Cancel; once finished, the outcome (what changed, or the error) until dismissed. A switch to
// an image on the server builds nothing: it only checks the version. Screen readers hear the phases through
// JobAnnouncer, not every log line.

const IDLE: AgentActionState = { status: "idle" };

interface AgentJobProps {
  job: AgentUpdateJob;
  /** The job's agent as the overview shows it now. */
  agent: AgentVersionInfo;
  /** Something changed: poll now. */
  onChanged: () => void;
  onDismiss: () => void;
  /** Hands the focus from the running panel to the outcome when the job ends. */
  focusHandoff: RefObject<boolean>;
}

export function AgentJob({ job, agent, onChanged, onDismiss, focusHandoff }: AgentJobProps) {
  if (!isJobActive(job)) {
    const finishedAt = job.finishedAt ?? job.startedAt;
    return (
      <JobOutcome
        outcome={job.phase === "succeeded" ? "succeeded" : job.phase === "cancelled" ? "cancelled" : "failed"}
        title={jobTitle(job, agent.name)}
        error={job.phase === "failed" ? job.error : null}
        log={job.log}
        onDismiss={onDismiss}
        focusHandoff={focusHandoff}
      >
        {jobOutcome(job, agent)}{" "}
        <span className="tabular-nums">
          Finished <LocalTime at={finishedAt} relative />, after {formatElapsed(jobElapsedMs(job, finishedAt))}
          {job.rebuild ? ", from scratch" : ""}.
        </span>
      </JobOutcome>
    );
  }
  const step = agentJobStep(job);
  return (
    <JobPanel
      title={jobTitle(job, agent.name)}
      stage={`Step ${step.index} of ${step.count} · ${phaseLabel(job.phase)}${job.rebuild ? " · from scratch" : ""}`}
      progress={step.progress}
      step={job.step}
      startedAt={job.startedAt}
      log={job.log}
      actions={<CancelButton onChanged={onChanged} />}
      focusHandoff={focusHandoff}
    />
  );
}

function CancelButton({ onChanged }: { onChanged: () => void }) {
  const [state, cancel, pending] = useActionState(cancelAgentUpdate, IDLE);
  /** Asked, or accepted and waiting for the job to stop: a second press would change nothing. */
  const cancelling = pending || state.status === "done";
  const changed = useEffectEvent(onChanged);

  useEffect(() => {
    if (state.status === "done") changed();
  }, [state]);

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Not disabled while cancelling, so the focus stays on it; presses are ignored. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled={cancelling || undefined}
        aria-busy={cancelling || undefined}
        onClick={() => {
          if (!cancelling) startTransition(() => cancel());
        }}
      >
        {cancelling ? <Spinner aria-hidden="true" /> : null}
        {cancelling ? "Cancelling…" : "Cancel"}
      </Button>
      {state.status === "error" ? <FormError>{state.message}</FormError> : null}
    </div>
  );
}

/** Says politely what the job is doing when its phase changes; empty without a job. Always rendered. */
export function JobAnnouncer({ job, name }: { job: AgentUpdateJob | null; name: string }) {
  const text = !job ? "" : isJobActive(job) ? `${jobTitle(job, name)}: ${phaseLabel(job.phase)}` : jobTitle(job, name);
  return (
    <p role="status" className="sr-only">
      {text}
    </p>
  );
}
