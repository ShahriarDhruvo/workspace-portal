"use client";

import { useRef } from "react";
import type { AppsOverview, AppVersion, EngineUpdateJob, UpdateDrain } from "@portal/core/wire";
import { removeAppVersion, restartAppNow, updateApp } from "@/lib/actions/updates";
import {
  appPackageRows,
  appRemoveBlocker,
  appStatusBadge,
  appUpdateBlocker,
  appUpdateTarget,
  type AppEntry,
  type AppPackageRow,
} from "@/lib/app-updates";
import { formatBytes } from "@/lib/format";
import { cutOffText, isJobActive, type Loaded } from "@/lib/update-jobs";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { GuardedButton } from "@/components/common/guarded-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { WarningIcon } from "@/components/ui/icons";
import { AppJob } from "./host-job";
import { PackageImages, type PackageImageRow } from "./package-images";
import { useDialog } from "./use-dialog";
import { useShownJob } from "./use-shown-job";
import { UnreachableAlert, VersionCard } from "./version-card";

const GROUP_TITLE = "Other software on the AI server";

interface AppCardsProps {
  data: Loaded<AppsOverview>;
  /** Gufo's job: it holds the AI server's one job slot too. */
  engineJob: EngineUpdateJob | null;
  onChanged: () => void;
}

/**
 * A card for each program portal-hostd updates on the AI server (llama-swap, vLLM, the media programs). Without
 * portal-hostd there it shows nothing: Gufo's card says how to set it up.
 */
export function AppCards({ data, engineJob, onChanged }: AppCardsProps) {
  const overview = data.data;
  const [shownJob, dismissJob] = useShownJob("apps", overview?.job ?? null);
  const failed = { label: "Can't reach", variant: "destructive", pending: false } as const;
  if (!overview) {
    return (
      <VersionCard title={GROUP_TITLE} status={failed}>
        <UnreachableAlert title="The workspace service can't be reached" message={data.error?.message ?? null} onRetry={onChanged}>
          Updates of the AI server&apos;s other software are unavailable until it answers.
        </UnreachableAlert>
      </VersionCard>
    );
  }
  if (overview.state === "off") return null;
  if (overview.state === "offline") {
    return (
      <VersionCard title={GROUP_TITLE} status={failed}>
        <UnreachableAlert title="portal-hostd on the AI server can't be reached" message={overview.error} onRetry={onChanged}>
          Updates of the AI server&apos;s other software are unavailable until it answers. The programs may still be serving.
        </UnreachableAlert>
      </VersionCard>
    );
  }
  if (overview.state === "no_apps" || overview.apps.length === 0) {
    return (
      <VersionCard title={GROUP_TITLE} status={{ label: "None", variant: "secondary", pending: false }}>
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No other software to update</EmptyTitle>
            <EmptyDescription>
              {overview.error ?? "portal-hostd on the AI server finds none of the programs it updates. The guide's steps install them."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </VersionCard>
    );
  }
  return overview.apps.map((entry) => (
    <AppCard
      key={entry.status.id}
      entry={entry}
      overview={overview}
      unreachable={data.error !== null}
      unreachableMessage={data.error?.message ?? null}
      engineJob={engineJob}
      shownJob={shownJob?.app === entry.status.id ? shownJob : null}
      onDismissJob={dismissJob}
      onChanged={onChanged}
    />
  ));
}

/** install: the card's "Update to …" (`update`), or a Versions row's Use…, Install… or Download…. */
type AppDialog =
  | { kind: "install"; row: AppPackageRow; update: boolean }
  | { kind: "restart"; drain: UpdateDrain | null }
  | { kind: "remove"; version: AppVersion };

interface AppCardProps {
  entry: AppEntry;
  overview: AppsOverview;
  /** The last poll failed: what is shown may be out of date. */
  unreachable: boolean;
  unreachableMessage: string | null;
  engineJob: EngineUpdateJob | null;
  /** This program's job, while it runs and until dismissed. */
  shownJob: AppsOverview["job"];
  onDismissJob: (jobId: string) => void;
  onChanged: () => void;
}

function AppCard({ entry, overview, unreachable, unreachableMessage, engineJob, shownJob, onDismissJob, onChanged }: AppCardProps) {
  const { status, releases } = entry;
  const { dialog, open, setOpen, opener, show } = useDialog<AppDialog | null>(null);
  /** Takes the focus once a removed version's row, and its Remove button, is gone. */
  const versionsTrigger = useRef<HTMLButtonElement>(null);
  const files = status.kind === "dir";
  const job = overview.job;
  const blocked = appUpdateBlocker(overview, unreachable, engineJob);
  const target = appUpdateTarget(entry);
  const packages = appPackageRows(entry);
  const targetRow = packages.find((row) => row.version === target) ?? null;
  const rows = packages.map((row): PackageImageRow => {
    const installed = row.image;
    return {
      ...row,
      current: row.running,
      action: row.running
        ? null
        : {
            label: installed ? "Use…" : files ? "Install…" : "Download…",
            blockedReason: blocked,
            onClick: (from) => show({ kind: "install", row, update: false }, from),
          },
      remove:
        installed && !installed.current
          ? {
              label: "Remove…",
              blockedReason: appRemoveBlocker(overview, unreachable, engineJob, installed),
              onClick: (from) => show({ kind: "remove", version: installed }, from),
            }
          : null,
    };
  });
  const badge = appStatusBadge(overview, entry);
  const source = files ? "GitHub" : "The image registry";

  return (
    <VersionCard
      title={status.name}
      subtitle={releases.source}
      status={badge}
      version={{ label: "In use on the AI server", value: status.version ?? "unknown" }}
      actions={
        targetRow && !isJobActive(job) ? (
          <GuardedButton blockedReason={blocked} onClick={(event) => show({ kind: "install", row: targetRow, update: true }, event.currentTarget)}>
            Update to {targetRow.version}…
          </GuardedButton>
        ) : null
      }
      sections={
        <PackageImages
          name={status.name}
          title={files ? "Versions" : "Package images"}
          column={files ? "Installed" : "Image"}
          rows={rows}
          currentLabel="In use"
          missingLabel={files ? "Install first" : "Download first"}
          where="the AI server"
          empty={files ? "Unknown until GitHub answers." : "Unknown until the image registry answers."}
          triggerRef={versionsTrigger}
        />
      }
    >
      {unreachable ? (
        <Alert variant="warning" role="status">
          <WarningIcon />
          <AlertTitle className="line-clamp-none">The workspace service can&apos;t be reached</AlertTitle>
          <AlertDescription>{unreachableMessage} What is shown may be out of date.</AlertDescription>
        </Alert>
      ) : null}
      {status.error ? (
        <Alert variant="warning" role="status">
          <WarningIcon />
          <AlertTitle className="line-clamp-none">portal-hostd can&apos;t read the installed versions</AlertTitle>
          <AlertDescription>{status.error}</AlertDescription>
        </Alert>
      ) : null}
      {releases.error ? (
        <Alert variant="warning" role="status">
          <WarningIcon />
          <AlertTitle className="line-clamp-none">{source} can&apos;t be reached</AlertTitle>
          <AlertDescription>
            {releases.error} The versions shown are from the last check; updates may fail until it answers.
          </AlertDescription>
        </Alert>
      ) : null}
      <p role="status" className="sr-only">
        {job && isJobActive(job) && job.app === status.id ? `${badge.label} ${job.step}` : ""}
      </p>
      {shownJob ? (
        <AppJob
          key={shownJob.id}
          job={shownJob}
          onChanged={onChanged}
          onRestartNow={(from) => show({ kind: "restart", drain: shownJob.drain }, from)}
          onDismiss={() => onDismissJob(shownJob.id)}
        />
      ) : null}
      {dialog ? (
        <AppDialogs
          dialog={dialog}
          entry={entry}
          drainMinutes={overview.drainMinutes}
          open={open}
          onOpenChange={setOpen}
          onDone={() => {
            if (dialog.kind === "remove") opener.current = versionsTrigger.current;
            onChanged();
          }}
          opener={opener}
        />
      ) : null}
    </VersionCard>
  );
}

interface AppDialogsProps {
  dialog: AppDialog;
  entry: AppEntry;
  drainMinutes: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  opener: React.RefObject<HTMLElement | null>;
}

/** The confirmation of whichever action was asked for; it stays mounted while it closes. */
function AppDialogs({ dialog, entry, drainMinutes, open, onOpenChange, onDone, opener }: AppDialogsProps) {
  const { status } = entry;
  const name = status.name;
  const files = status.kind === "dir";
  const current = status.version ?? "the version in use";
  const common = { open, onOpenChange, onDone, returnFocusTo: opener };
  const em = (text: string) => <span className="font-mono text-foreground">{text}</span>;
  switch (dialog.kind) {
    case "install": {
      const { row } = dialog;
      // Said as the button that opened it said it.
      const verb = row.image ? "Use" : files ? "Install" : "Download";
      return (
        <ConfirmDialog
          {...common}
          title={dialog.update ? `Update ${name} to ${row.version}?` : `${verb} ${name} ${row.version}?`}
          confirm={dialog.update ? `Update to ${row.version}` : `${verb} ${row.version}`}
          pending="Starting…"
          onConfirm={() => updateApp(status.id, row.version)}
        >
          {row.notes?.breaking ? (
            <span className="flex flex-col items-center gap-1.5 sm:items-start">
              <Badge variant="destructive">Breaking changes</Badge>
              <span>Read its release notes first: {em(row.version)} changes how {name} behaves.</span>
            </span>
          ) : null}
          <p>
            {row.image
              ? "It is on the AI server already. "
              : files
                ? `It installs first, while ${name} keeps serving. `
                : `Its image downloads first, while ${name} keeps serving. `}
            Then new LLM requests wait in the portal&apos;s queue while the running ones finish (at most {drainMinutes} minutes;
            nothing fails), and {name} restarts with {em(row.version)}.
          </p>
          <p>
            {status.model
              ? `To check it, llama-swap stops the running models and starts ${name}; then the LLM starts again.`
              : "Its restart stops every model; then the LLM starts again."}{" "}
            If it doesn&apos;t start properly, the AI server puts {em(current)} back by itself.
          </p>
        </ConfirmDialog>
      );
    }
    case "restart":
      return (
        <ConfirmDialog
          {...common}
          title={`Restart ${name} now?`}
          confirm="Restart now"
          pending="Restarting…"
          destructive
          onConfirm={restartAppNow}
        >
          <p>{cutOffText(dialog.drain)}</p>
          <p>Requests waiting in the queue go on once the AI server answers again.</p>
        </ConfirmDialog>
      );
    case "remove": {
      const { version } = dialog;
      return (
        <ConfirmDialog
          {...common}
          title={`Remove ${name} ${version.version}?`}
          confirm="Remove"
          pending="Removing…"
          destructive
          onConfirm={() => removeAppVersion(status.id, version.version)}
        >
          <p>
            Remove {em(version.version)}
            {version.sizeBytes ? ` (${formatBytes(version.sizeBytes)})` : ""} from the AI server? Using that version later{" "}
            {files ? "installs" : "downloads"} it again.
          </p>
        </ConfirmDialog>
      );
    }
  }
}
