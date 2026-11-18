"use client";

import type { RefObject } from "react";
import { cancelAgentUpdate } from "@/lib/actions/updates";
import { agentJobStep, formatElapsed, jobElapsedMs, jobOutcome, jobTitle, phaseLabel } from "@/lib/agent-versions";
import { isJobActive } from "@/lib/update-jobs";
import type { AgentUpdateJob, AgentVersionInfo } from "@portal/core/wire";
import { LocalTime } from "@/components/local-time";
import { JobButtons, JobOutcome, JobPanel } from "./version-card";

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

/** The agents' update job, inline in its agent's card: its panel while it runs, then the outcome until dismissed. */
export function AgentJob({ job, agent, onChanged, onDismiss, focusHandoff }: AgentJobProps) {
  if (!isJobActive(job)) {
    const finishedAt = job.finishedAt ?? job.startedAt;
    return (
      <JobOutcome job={job} title={jobTitle(job, agent.name)} onDismiss={onDismiss} focusHandoff={focusHandoff}>
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
      actions={<JobButtons cancel={cancelAgentUpdate} onChanged={onChanged} staysBusy />}
      focusHandoff={focusHandoff}
    />
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
