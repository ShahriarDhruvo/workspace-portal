"use client";

import { useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type Ref, type RefObject } from "react";
import { formatElapsed } from "@/lib/agent-versions";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CancelledIcon, ChevronDownIcon, CloseIcon, FailedIcon, RefreshIcon, SuccessIcon, WarningIcon } from "@/components/ui/icons";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { BuildLog } from "./build-log";

// The one layout of the Updates page's cards (the LLM engine, Qwen Code, DeepSeek Harness), so each reads the same
// way: the title and a status badge; the focal point, the current version large in mono, with the one primary
// action beside it; the running job's panel inline under it; and the secondary details (versions, images, notes)
// collapsed at the bottom.

export type StatusVariant = "success" | "warning" | "info" | "secondary" | "destructive";

export interface CardStatus {
  label: string;
  variant: StatusVariant;
  /** Something is under way: a spinner in the badge. */
  pending?: boolean;
}

interface VersionCardProps {
  title: string;
  /** The package or image repository, in mono. */
  subtitle?: string | null;
  status: CardStatus;
  /** The focal point; omitted when there is no version to show (not set up, unreachable). */
  version?: { label: string; value: string; note?: ReactNode };
  /** The primary action (and at most one secondary), beside the version. */
  actions?: ReactNode;
  /** Under the version: the job panel, notices, an empty state. */
  children?: ReactNode;
  /** Collapsed details (VersionSection), at the bottom. */
  sections?: ReactNode;
  /** Makes the title a focus target: for when the control that had the focus goes away (a dismissed outcome). */
  headingRef?: Ref<HTMLHeadingElement>;
}

export function VersionCard({ title, subtitle, status, version, actions, children, sections, headingRef }: VersionCardProps) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle>
          <h2 id={titleId} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-16 outline-none">
            {title}
          </h2>
        </CardTitle>
        {subtitle ? (
          <CardDescription className="font-mono text-12 wrap-anywhere">
            {/* Breaks after a slash first: "ghcr.io/org/" then "image". */}
            {subtitle.split("/").map((part, index) => (
              <span key={index}>
                {index > 0 ? "/" : null}
                {index > 0 ? <wbr /> : null}
                {part}
              </span>
            ))}
          </CardDescription>
        ) : null}
        <CardAction>
          <Badge variant={status.variant}>
            {status.pending ? <Spinner aria-hidden="true" /> : null}
            {status.label}
          </Badge>
        </CardAction>
      </CardHeader>
      {version || actions || children ? (
        <CardContent className="flex flex-col gap-4">
          {version || actions ? (
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              {version ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-12 text-muted-foreground">{version.label}</span>
                  <span className="font-mono text-24 leading-8 font-semibold break-all tabular-nums">{version.value}</span>
                  {version.note ? <div className="text-13 text-muted-foreground">{version.note}</div> : null}
                </div>
              ) : null}
              {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          ) : null}
          {children}
        </CardContent>
      ) : null}
      {sections ? <CardFooter className="flex-col items-stretch gap-0 bg-transparent p-0">{sections}</CardFooter> : null}
    </Card>
  );
}

/** One collapsed detail of a card: a full-width trigger with a title and a short summary, then its content. */
export function VersionSection({
  title,
  summary,
  children,
  triggerRef,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  /** The trigger, as a focus target once the control that had the focus inside is gone (a removed image's row). */
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Collapsible className="group/section border-t first:border-t-0">
      <CollapsibleTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          className="h-auto min-h-11 w-full justify-between gap-3 rounded-none px-4 py-2.5 text-left whitespace-normal aria-expanded:bg-transparent hover:aria-expanded:bg-muted dark:hover:aria-expanded:bg-muted/50"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-13 font-medium">{title}</span>
            {summary ? <span className="text-12 font-normal text-muted-foreground">{summary}</span> : null}
          </span>
          <ChevronDownIcon className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]/section:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 px-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function subscribeSeconds(onTick: () => void): () => void {
  const timer = setInterval(onTick, 1000);
  return () => clearInterval(timer);
}

/** The time in whole seconds, ticking; null on the server (its clock is not the viewer's). */
export function useSeconds(): number | null {
  return useSyncExternalStore(
    subscribeSeconds,
    () => Math.floor(Date.now() / 1000),
    () => null,
  );
}

interface JobPanelProps {
  title: string;
  /** "Step 2 of 3 · Waiting for running requests". */
  stage: string;
  /** 0-100. */
  progress: number;
  /** What it does right now, in the gateway's words. */
  step?: string | null;
  startedAt: number;
  log: readonly string[];
  /** Facts of the stage (the drain's requests and deadline). */
  children?: ReactNode;
  /** Cancel, Restart now. */
  actions?: ReactNode;
  /** Set as the panel goes (the job finished) if the focus was in it: the outcome's title then takes it. */
  focusHandoff?: RefObject<boolean>;
}

/** A running job, inline in its card: what, where (a Progress), the current step, the log on request, its buttons. */
export function JobPanel({ title, stage, progress, step, startedAt, log, children, actions, focusHandoff }: JobPanelProps) {
  const seconds = useSeconds();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = panel.current;
    // A layout cleanup runs before React removes the panel, while the focus is still where it was.
    return () => {
      if (focusHandoff) focusHandoff.current = node?.contains(document.activeElement) ?? false;
    };
  }, [focusHandoff]);
  return (
    <section ref={panel} aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="text-14 font-medium break-words">
            {title}
          </h3>
          <p className="text-13 text-muted-foreground tabular-nums">
            {stage}
            {seconds === null ? null : ` · ${formatElapsed(Math.max(0, seconds * 1000 - startedAt))}`}
          </p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <Progress value={progress} aria-label={stage} />
      {step ? (
        <p className="truncate font-mono text-12 text-muted-foreground" title={step}>
          {step}
        </p>
      ) : null}
      {children}
      <LogSection lines={log} />
    </section>
  );
}

/** The job's log, collapsed until asked for. */
function LogSection({ lines, defaultOpen = false }: { lines: readonly string[]; defaultOpen?: boolean }) {
  if (lines.length === 0) return null;
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/log flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground">
          <ChevronDownIcon className="transition-transform group-data-[state=open]/log:rotate-180" />
          <span className="group-data-[state=open]/log:hidden">Show log</span>
          <span className="hidden group-data-[state=open]/log:inline">Hide log</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <BuildLog lines={lines} />
      </CollapsibleContent>
    </Collapsible>
  );
}

const OUTCOMES = {
  succeeded: { variant: "default", Icon: SuccessIcon, tone: "text-success" },
  failed: { variant: "destructive", Icon: FailedIcon, tone: "" },
  cancelled: { variant: "default", Icon: CancelledIcon, tone: "text-muted-foreground" },
} as const;

interface JobOutcomeProps {
  outcome: keyof typeof OUTCOMES;
  title: string;
  /** What it means now. */
  children: ReactNode;
  /** The failure in the gateway's words. */
  error?: string | null;
  log: readonly string[];
  onDismiss: () => void;
  /** The running job's panel had the focus as it went: the title takes it. */
  focusHandoff?: RefObject<boolean>;
}

/** A finished job, inline in its card until dismissed: what happened, the error, the log on request. */
export function JobOutcome({ outcome, title, children, error, log, onDismiss, focusHandoff }: JobOutcomeProps) {
  const { variant, Icon, tone } = OUTCOMES[outcome];
  const heading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!focusHandoff?.current) return;
    focusHandoff.current = false;
    heading.current?.focus();
  }, [focusHandoff]);
  return (
    // Not a live region itself: the page's status line says it, once.
    <Alert variant={variant} role={undefined} className="pr-11">
      <Icon className={cn(tone)} />
      <AlertTitle ref={heading} tabIndex={-1} className="line-clamp-none outline-none">
        {title}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2 [&_p:not(:last-child)]:mb-0">
        {error ? <p className="font-mono text-12 wrap-anywhere whitespace-pre-wrap">{error}</p> : null}
        <p>{children}</p>
        <div className="w-full">
          <LogSection lines={log} />
        </div>
      </AlertDescription>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss" className="absolute top-1.5 right-1.5" onClick={onDismiss}>
        <CloseIcon />
      </Button>
    </Alert>
  );
}

/** A card's data can't be read: what failed, what that means, and Retry. */
export function UnreachableAlert({
  title,
  message,
  children,
  onRetry,
}: {
  title: string;
  message: string | null;
  children: ReactNode;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2 [&_p:not(:last-child)]:mb-0">
        {message ? <p className="font-mono text-12 wrap-anywhere">{message}</p> : null}
        <p>{children}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshIcon />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
