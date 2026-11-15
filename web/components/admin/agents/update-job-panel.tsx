"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { cancelAgentUpdate, type AgentActionState } from "@/lib/actions/agents";
import { formatElapsed, isJobActive, jobElapsedMs, jobOutcome, jobTitle, phaseLabel } from "@/lib/agent-versions";
import type { AgentUpdateJob, AgentVersionInfo } from "@/lib/gateway-types";
import { FormError } from "@/components/forms/form-error";
import { LocalTime } from "@/components/local-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CancelledIcon, CloseIcon, FailedIcon, SuccessIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { BuildLog } from "./build-log";

// The update job, as the Agents page shows it: while it runs, a panel with the phase, elapsed time, current build
// step, the log tail and Cancel; once finished, an outcome notice (what changed, or the error) with the log on
// request, until the admin dismisses it. A switch to an image on the server builds nothing: it goes straight to
// verifying, its log only saying which image it uses and what the version check found. Screen readers hear the
// phases through JobAnnouncer, not every log line. When the job ends with the focus in the progress panel (on
// Cancel update, say), the outcome's title takes it, rather than <body> as the panel goes.

const IDLE: AgentActionState = { status: "idle" };

interface UpdateJobPanelProps {
  job: AgentUpdateJob;
  /** The job's agent's display name. */
  name: string;
  /** The job's agent as the overview shows it now (null if it is no longer enabled). */
  agent: AgentVersionInfo | null;
  /** Something changed: poll now. */
  onChanged: () => void;
  onDismiss: () => void;
}

export function UpdateJobPanel({ job, name, agent, onChanged, onDismiss }: UpdateJobPanelProps) {
  /** The progress panel had the focus as it gave way to the outcome. */
  const hadFocus = useRef(false);
  return isJobActive(job) ? (
    <JobProgress job={job} name={name} onChanged={onChanged} hadFocus={hadFocus} />
  ) : (
    <JobOutcome job={job} name={name} agent={agent} onDismiss={onDismiss} takeFocus={hadFocus} />
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

function subscribeSeconds(onTick: () => void): () => void {
  const timer = setInterval(onTick, 1000);
  return () => clearInterval(timer);
}

/** The time in whole seconds, ticking; null on the server (its clock is not the viewer's). */
function useSeconds(): number | null {
  return useSyncExternalStore(subscribeSeconds, () => Math.floor(Date.now() / 1000), () => null);
}

interface JobProgressProps {
  job: AgentUpdateJob;
  name: string;
  onChanged: () => void;
  /** Set as the panel goes, if the focus was in it. */
  hadFocus: RefObject<boolean>;
}

function JobProgress({ job, name, onChanged, hadFocus }: JobProgressProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const seconds = useSeconds();
  const [state, cancel, pending] = useActionState(cancelAgentUpdate, IDLE);
  /** Asked, or accepted and waiting for the job to stop: a second press would change nothing. */
  const cancelling = pending || state.status === "done";
  const changed = useEffectEvent(onChanged);

  useEffect(() => {
    if (state.status === "done") changed();
  }, [state]);

  useLayoutEffect(() => {
    const node = panel.current;
    // A layout cleanup runs before React removes the panel, while the focus is still where it was.
    return () => {
      hadFocus.current = node?.contains(document.activeElement) ?? false;
    };
  }, [hadFocus]);

  const facts = [
    phaseLabel(job.phase),
    seconds === null ? null : formatElapsed(jobElapsedMs(job, seconds * 1000)),
    job.rebuild ? "from scratch" : null,
  ].filter(Boolean);

  return (
    <Card ref={panel} variant="outline" role="region" aria-labelledby={titleId} className="gap-3 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Spinner aria-hidden="true" className="mt-0.5 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={titleId} className="text-14 font-medium break-words">
              {jobTitle(job, name)}
            </h2>
            <p className="text-13 text-muted-foreground tabular-nums">{facts.join(" · ")}</p>
          </div>
        </div>
        {/* Not disabled while cancelling, so the focus stays on it (like Check for updates); presses are ignored. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={cancelling || undefined}
          aria-busy={cancelling || undefined}
          data-pending={cancelling ? "" : undefined}
          onClick={() => {
            if (!cancelling) startTransition(() => cancel());
          }}
        >
          {cancelling ? <Spinner aria-hidden="true" /> : null}
          {cancelling ? "Cancelling…" : "Cancel update"}
        </Button>
      </div>
      {job.step ? (
        <p className="truncate font-mono text-12 text-muted-foreground" title={job.step}>
          <span className="text-subtle-foreground">Step: </span>
          {job.step}
        </p>
      ) : null}
      {job.phase === "building" || job.log.length > 0 ? <BuildLog lines={job.log} /> : null}
      {state.status === "error" ? <FormError>{state.message}</FormError> : null}
    </Card>
  );
}

const OUTCOME = {
  succeeded: { variant: "default", Icon: SuccessIcon },
  failed: { variant: "destructive", Icon: FailedIcon },
  cancelled: { variant: "muted", Icon: CancelledIcon },
} as const;

interface JobOutcomeProps extends Omit<UpdateJobPanelProps, "onChanged"> {
  /** The progress panel had the focus as it went: the title takes it. */
  takeFocus: RefObject<boolean>;
}

function JobOutcome({ job, name, agent, onDismiss, takeFocus }: JobOutcomeProps) {
  const logId = useId();
  const title = useRef<HTMLDivElement>(null);
  const [showLog, setShowLog] = useState(false);
  const { variant, Icon } = OUTCOME[job.phase as keyof typeof OUTCOME];
  const finishedAt = job.finishedAt ?? job.startedAt;

  useLayoutEffect(() => {
    if (!takeFocus.current) return;
    takeFocus.current = false;
    title.current?.focus();
  }, [takeFocus]);

  return (
    // Not a live region itself: JobAnnouncer has said it, once.
    <Alert variant={variant} role={undefined} className="pr-11">
      <Icon />
      <AlertTitle ref={title} tabIndex={-1} className="line-clamp-none outline-none">
        {jobTitle(job, name)}
      </AlertTitle>
      <AlertDescription className="gap-2">
        {job.phase === "failed" && job.error ? (
          <p className="font-mono text-12 wrap-anywhere whitespace-pre-wrap">{job.error}</p>
        ) : null}
        <p>{jobOutcome(job, agent)}</p>
        <p className="text-12 tabular-nums">
          Finished <LocalTime at={finishedAt} relative />, after {formatElapsed(jobElapsedMs(job, finishedAt))}
          {job.rebuild ? " · from scratch" : ""}
        </p>
        {job.log.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={showLog}
            aria-controls={showLog ? logId : undefined}
            onClick={() => setShowLog((shown) => !shown)}
          >
            {showLog ? "Hide build log" : "Show build log"}
          </Button>
        ) : null}
        {showLog ? <BuildLog id={logId} lines={job.log} /> : null}
      </AlertDescription>
      <Button type="button" variant="muted" size="icon" aria-label="Dismiss" className="absolute top-1.5 right-1.5" onClick={onDismiss}>
        <CloseIcon />
      </Button>
    </Alert>
  );
}
