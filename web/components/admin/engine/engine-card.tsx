"use client";

import { useRef, useState } from "react";
import { removeEngineImage, restartEngineNow, rollbackEngine, updateEngine } from "@/lib/actions/engine";
import type { AdminEngine, EngineImage, EngineOverview, EngineRelease } from "@/lib/engine-types";
import {
  compareEngineVersions,
  engineRemoveBlocker,
  engineStatusBadge,
  engineUpdateBlocker,
  engineUpdateTarget,
  isEngineJobActive,
  newerEngineReleases,
} from "@/lib/engine-updates";
import { formatBytes } from "@/lib/format";
import { CopyButton } from "@/components/common/secret-value";
import { GuardedButton } from "@/components/common/guarded-button";
import { useDismissedJob } from "@/components/admin/agents/use-dismissed-job";
import { UnreachableAlert, VersionCard, VersionSection } from "@/components/admin/agents/version-card";
import { LocalTime } from "@/components/local-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { WarningIcon } from "@/components/ui/icons";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { EngineJob } from "./engine-job";
import { ReleaseNotes } from "./release-notes";
import { ImagesTable, ReleasesTable } from "./engine-tables";

const SETUP_COMMAND = "sudo bash ~/workspace-portal/hostd/install.sh llm --portal <portal IP>";

type EngineDialog =
  | { kind: "install"; release: EngineRelease }
  | { kind: "rollback"; version: string | null }
  | { kind: "restart"; inFlight: number }
  | { kind: "remove"; image: EngineImage };

interface EngineCardProps {
  data: AdminEngine;
  /** Something changed, or Retry: poll now. */
  onChanged: () => void;
}

/**
 * The LLM engine on the Updates page, in the same layout as the agents' cards: what runs and its status, "Update to
 * X.Y.Z" when a newer release is out, rollback beside it, the job inline, and the releases, their notes and the
 * images on the LLM server collapsed below. Without portal-hostd on the LLM server it says how to set it up.
 */
export function EngineCard({ data, onChanged }: EngineCardProps) {
  const overview = data.engine;
  const unreachable = data.error !== null;
  const status = engineStatusBadge(overview, unreachable && !overview);
  const [dismissedJob, dismissJob] = useDismissedJob("engine");
  const [dialog, setDialog] = useState<EngineDialog | null>(null);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  /** Takes the focus once a removed image's row, and its Remove button, is gone. */
  const imagesTrigger = useRef<HTMLButtonElement>(null);

  function show(next: EngineDialog, from: HTMLElement) {
    opener.current = from;
    setDialog(next);
    setOpen(true);
  }

  const title = "LLM engine";
  if (!overview) {
    return (
      <VersionCard title={title} status={status}>
        <UnreachableAlert title="The workspace service can't be reached" message={data.error?.message ?? null} onRetry={onChanged}>
          Engine updates are unavailable until it answers.
        </UnreachableAlert>
      </VersionCard>
    );
  }
  if (overview.state === "off") {
    return (
      <VersionCard title={title} status={status}>
        <Setup />
      </VersionCard>
    );
  }
  if (overview.state === "offline") {
    return (
      <VersionCard title={title} status={status}>
        <UnreachableAlert title="portal-hostd on the LLM server can't be reached" message={overview.error} onRetry={onChanged}>
          Engine updates are unavailable until it answers. The engine itself may still be serving.
        </UnreachableAlert>
      </VersionCard>
    );
  }
  if (overview.state === "no_engine" || !overview.engine) {
    return (
      <VersionCard title={title} status={status}>
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No engine to update</EmptyTitle>
            <EmptyDescription>
              {overview.error ??
                "portal-hostd on the LLM server doesn't control an engine. Install it there with the engine's systemd unit and quadlet."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </VersionCard>
    );
  }

  const engine = overview.engine;
  const job = overview.job;
  const blocked = engineUpdateBlocker(overview, unreachable);
  const target = engineUpdateTarget(overview);
  const targetRelease = overview.releases?.releases.find((release) => release.version === target) ?? null;
  const shownJob = job && (isEngineJobActive(job) || (dismissedJob !== undefined && dismissedJob !== job.id)) ? job : null;
  const newer = newerEngineReleases(overview);
  const noteReleases =
    newer.length > 0 ? newer : (overview.releases?.releases ?? []).filter((release) => release.version === engine.version);
  const onServer = new Set(engine.images.map((image) => image.digest).filter((digest): digest is string => digest !== null));

  return (
    <VersionCard
      title={title}
      subtitle={engine.repository}
      status={status}
      version={{
        label: "Running on the LLM server",
        value: engine.version ?? "unknown",
        note: (
          <>
            {engine.ready ? `${engine.unit} answers.` : `${engine.unit} is starting.`}{" "}
            {overview.releases?.checkedAt ? (
              <>
                Releases checked <LocalTime at={overview.releases.checkedAt} relative />.
              </>
            ) : null}
          </>
        ),
      }}
      actions={
        // While a job runs its panel is the focus, and nothing else can start anyway.
        job && isEngineJobActive(job) ? null : (
          <>
            {/* Rolling back reuses the previous image; once it's removed, Versions installs that version again. */}
            {engine.previous && engine.images.some((image) => image.previous) ? (
              <GuardedButton
                variant="outline"
                blockedReason={blocked}
                onClick={(event) => show({ kind: "rollback", version: engine.previous?.version ?? null }, event.currentTarget)}
              >
                Roll back to {engine.previous.version ?? "the previous version"}…
              </GuardedButton>
            ) : null}
            {targetRelease ? (
              <GuardedButton
                blockedReason={blocked}
                onClick={(event) => show({ kind: "install", release: targetRelease }, event.currentTarget)}
              >
                Update to {targetRelease.version}…
              </GuardedButton>
            ) : null}
          </>
        )
      }
      sections={
        <>
          <VersionSection
            title="Release notes"
            summary={
              newer.length > 0 ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {newer.length === 1 ? `${newer[0]?.version} is newer` : `${newer.length} newer versions`}
                  {newer.some((release) => release.notes?.breaking) ? <Badge variant="destructive">Breaking changes</Badge> : null}
                </span>
              ) : (
                "This version"
              )
            }
          >
            {noteReleases.length > 0 ? (
              <div className="flex flex-col gap-5">
                {noteReleases.map((release) => (
                  <ReleaseNotes key={release.version} release={release} />
                ))}
              </div>
            ) : (
              <p className="text-13 text-muted-foreground">No release notes yet.</p>
            )}
          </VersionSection>
          <VersionSection title="Versions" summary={`${overview.releases?.releases.length ?? 0} in the registry`}>
            {overview.releases && overview.releases.releases.length > 0 ? (
              <ReleasesTable
                releases={overview.releases.releases}
                current={engine.version}
                onServer={onServer}
                blockedReason={blocked}
                onInstall={(release, from) => show({ kind: "install", release }, from)}
              />
            ) : (
              <p className="text-13 text-muted-foreground">Unknown until the image registry answers.</p>
            )}
          </VersionSection>
          <VersionSection
            title="Images on the LLM server"
            triggerRef={imagesTrigger}
            summary={`${engine.images.length} ${engine.images.length === 1 ? "image" : "images"}`}
          >
            <ImagesTable
              images={engine.images}
              removeBlocker={(image) => engineRemoveBlocker(overview, unreachable, image)}
              onRemove={(image, from) => show({ kind: "remove", image }, from)}
            />
          </VersionSection>
        </>
      }
    >
      {unreachable ? (
        <Alert variant="warning" role="status">
          <WarningIcon />
          <AlertTitle className="line-clamp-none">The workspace service can&apos;t be reached</AlertTitle>
          <AlertDescription>{data.error?.message} What is shown may be out of date.</AlertDescription>
        </Alert>
      ) : null}
      {overview.releases?.error ? (
        <Alert variant="warning" role="status">
          <WarningIcon />
          <AlertTitle className="line-clamp-none">The image registry can&apos;t be reached</AlertTitle>
          <AlertDescription>
            {overview.releases.error} The versions shown are from the last check; updates may fail until it answers.
          </AlertDescription>
        </Alert>
      ) : null}
      <p role="status" className="sr-only">
        {job && isEngineJobActive(job) ? `${status.label} ${job.step}` : ""}
      </p>
      {shownJob ? (
        <EngineJob
          key={shownJob.id}
          job={shownJob}
          onChanged={onChanged}
          onRestartNow={(from) => show({ kind: "restart", inFlight: shownJob.drain?.inFlight ?? 0 }, from)}
          onDismiss={() => dismissJob(shownJob.id)}
        />
      ) : null}
      {dialog ? (
        <EngineDialogs
          dialog={dialog}
          overview={overview}
          open={open}
          onOpenChange={setOpen}
          onDone={() => {
            if (dialog.kind === "remove") opener.current = imagesTrigger.current;
            onChanged();
          }}
          opener={opener}
        />
      ) : null}
    </VersionCard>
  );
}

interface EngineDialogsProps {
  dialog: EngineDialog;
  overview: EngineOverview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  opener: React.RefObject<HTMLElement | null>;
}

/** The confirmation of whichever action was asked for; it stays mounted while it closes. */
function EngineDialogs({ dialog, overview, open, onOpenChange, onDone, opener }: EngineDialogsProps) {
  const current = overview.engine?.version ?? "the running version";
  const drain = `Then new LLM requests wait in the portal's queue while the running ones finish (at most ${overview.drainMinutes} minutes; nothing fails), and the engine restarts`;
  const common = { open, onOpenChange, onDone, returnFocusTo: opener };
  const em = (text: string) => <span className="font-mono text-foreground">{text}</span>;
  switch (dialog.kind) {
    case "install": {
      const { release } = dialog;
      const newer = overview.engine?.version ? compareEngineVersions(release.version, overview.engine.version) > 0 : true;
      const local = overview.engine?.images.some((image) => image.digest !== null && image.digest === release.digest);
      return (
        <ConfirmActionDialog
          {...common}
          title={`${newer ? "Update" : "Switch"} the LLM engine to ${release.version}`}
          confirm={`${newer ? "Update" : "Switch"} to ${release.version}`}
          pending="Starting…"
          onConfirm={() => updateEngine(release.version)}
        >
          {release.notes?.breaking ? (
            <span className="flex flex-col items-center gap-1.5 sm:items-start">
              <Badge variant="destructive">Breaking changes</Badge>
              <span>Read its release notes on this card first: {em(release.version)} changes how the engine behaves.</span>
            </span>
          ) : null}
          <p>
            {local ? "Its image is on the LLM server already. " : "Its image downloads first, while the engine keeps serving. "}
            {drain} with {em(release.version)}.
          </p>
          <p>If it doesn&apos;t start properly, the LLM server puts {em(current)} back by itself.</p>
        </ConfirmActionDialog>
      );
    }
    case "rollback":
      return (
        <ConfirmActionDialog
          {...common}
          title={`Roll back the LLM engine to ${dialog.version ?? "the previous version"}`}
          confirm="Roll back"
          pending="Starting…"
          onConfirm={rollbackEngine}
        >
          <p>
            The engine goes back to {em(dialog.version ?? "the previous version")}, the version that ran before the last change. New LLM
            requests wait in the portal&apos;s queue while the running ones finish (at most {overview.drainMinutes} minutes; nothing fails),
            then it restarts.
          </p>
        </ConfirmActionDialog>
      );
    case "restart":
      return (
        <ConfirmActionDialog
          {...common}
          title="Restart the engine now?"
          confirm="Restart now"
          pending="Restarting…"
          destructive
          onConfirm={restartEngineNow}
        >
          <p>
            {dialog.inFlight > 0
              ? `${dialog.inFlight} running ${dialog.inFlight === 1 ? "request is" : "requests are"} cut off: their agents get an error and may retry.`
              : "Requests still running are cut off: their agents get an error and may retry."}
          </p>
          <p>Requests waiting in the queue go to the engine once it answers again.</p>
        </ConfirmActionDialog>
      );
    case "remove": {
      const { image } = dialog;
      return (
        <ConfirmActionDialog
          {...common}
          title="Remove engine image"
          confirm="Remove"
          pending="Removing…"
          destructive
          onConfirm={() => removeEngineImage(image.digest ?? "", image.version)}
        >
          <p>
            Remove the {em(image.version ?? "unknown")} image{image.sizeBytes ? ` (${formatBytes(image.sizeBytes)})` : ""} from the LLM
            server? Installing that version again downloads it again
            {image.previous ? "; rolling back needs it, so rollback isn't possible until another update" : ""}.
          </p>
        </ConfirmActionDialog>
      );
    }
  }
}

/** No portal-hostd for the LLM server: the fix, in one paragraph and a command. */
function Setup() {
  return (
    <Empty className="border p-5">
      <EmptyHeader className="max-w-lg">
        <EmptyTitle>Engine updates aren&apos;t set up</EmptyTitle>
        <EmptyDescription>
          The portal updates the LLM engine through portal-hostd on the LLM server. Run this there, put the HOSTD_LLM_URL and
          HOSTD_LLM_TOKEN lines it prints in the portal&apos;s .env, and run{" "}
          <code className="font-mono text-12">sudo docker compose up -d</code>.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-lg">
        <div className="flex w-full flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 basis-64 rounded-md bg-muted px-3 py-2 text-left font-mono text-12 wrap-break-word">
            {SETUP_COMMAND}
          </code>
          <CopyButton value={SETUP_COMMAND} />
        </div>
      </EmptyContent>
    </Empty>
  );
}
