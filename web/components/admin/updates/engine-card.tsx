"use client";

import { useRef } from "react";
import { removeEngineImage, restartEngineNow, updateEngine } from "@/lib/actions/updates";
import type { EngineImage, EngineOverview } from "@portal/core/wire";
import { isJobActive, type Loaded } from "@/lib/update-jobs";
import {
  enginePackageRows,
  engineRemoveBlocker,
  engineStatusBadge,
  engineUpdateBlocker,
  engineUpdateTarget,
  type EnginePackageRow,
} from "@/lib/engine-updates";
import { formatBytes } from "@/lib/format";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CopyButton } from "@/components/common/secret-value";
import { GuardedButton } from "@/components/common/guarded-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { WarningIcon } from "@/components/ui/icons";
import { EngineJob } from "./engine-job";
import { PackageImages, type PackageImageRow } from "./package-images";
import { useDialog } from "./use-dialog";
import { useShownJob } from "./use-shown-job";
import { UnreachableAlert, VersionCard } from "./version-card";

const SETUP_COMMAND = "sudo bash ~/workspace-portal/hostd/install.sh llm --portal <portal IP>";

/** install: the card's "Update to X.Y.Z…" (`update`), or a Package images row's Use… or Download…. */
type EngineDialog =
  | { kind: "install"; row: EnginePackageRow; update: boolean }
  | { kind: "restart"; inFlight: number }
  | { kind: "remove"; image: EngineImage };

interface EngineCardProps {
  data: Loaded<EngineOverview>;
  onChanged: () => void;
}

/** The LLM engine on the Updates page. Without portal-hostd on the LLM server it says how to set it up. */
export function EngineCard({ data, onChanged }: EngineCardProps) {
  const overview = data.data;
  const unreachable = data.error !== null;
  const status = engineStatusBadge(overview, unreachable && !overview);
  const [shownJob, dismissJob] = useShownJob("engine", overview?.job ?? null);
  const { dialog, open, setOpen, opener, show } = useDialog<EngineDialog | null>(null);
  /** Takes the focus once a removed image's row, and its Remove button, is gone. */
  const imagesTrigger = useRef<HTMLButtonElement>(null);

  const title = "LLM engine";
  const card = (children: React.ReactNode) => <VersionCard title={title} status={status}>{children}</VersionCard>;
  if (!overview) {
    return card(
      <UnreachableAlert title="The workspace service can't be reached" message={data.error?.message ?? null} onRetry={onChanged}>
        Engine updates are unavailable until it answers.
      </UnreachableAlert>,
    );
  }
  if (overview.state === "off") return card(<Setup />);
  if (overview.state === "offline") {
    return card(
      <UnreachableAlert title="portal-hostd on the LLM server can't be reached" message={overview.error} onRetry={onChanged}>
        Engine updates are unavailable until it answers. The engine itself may still be serving.
      </UnreachableAlert>,
    );
  }
  if (overview.state === "no_engine" || !overview.engine) {
    return card(
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No engine to update</EmptyTitle>
          <EmptyDescription>
            {overview.error ??
              "portal-hostd on the LLM server doesn't control an engine. Install it there with the engine's systemd unit and quadlet."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>,
    );
  }

  const engine = overview.engine;
  const job = overview.job;
  const blocked = engineUpdateBlocker(overview, unreachable);
  const target = engineUpdateTarget(overview);
  const packages = enginePackageRows(overview.releases?.releases ?? [], engine);
  const targetRow = packages.find((row) => row.version === target) ?? null;
  const rows = packages.map((row): PackageImageRow => {
    const image = row.image;
    return {
      ...row,
      current: row.running,
      action: row.running
        ? null
        : {
            label: image ? "Use…" : "Download…",
            blockedReason: blocked,
            onClick: (from) => show({ kind: "install", row, update: false }, from),
          },
      remove:
        image && !image.current
          ? {
              label: "Remove…",
              blockedReason: engineRemoveBlocker(overview, unreachable, image),
              onClick: (from) => show({ kind: "remove", image }, from),
            }
          : null,
    };
  });

  return (
    <VersionCard
      title={title}
      subtitle={engine.repository}
      status={status}
      version={{ label: "Running on the LLM server", value: engine.version ?? "unknown" }}
      actions={
        targetRow && !(job && isJobActive(job)) ? (
          <GuardedButton blockedReason={blocked} onClick={(event) => show({ kind: "install", row: targetRow, update: true }, event.currentTarget)}>
            Update to {targetRow.version}…
          </GuardedButton>
        ) : null
      }
      sections={
        <PackageImages
          name="LLM engine"
          rows={rows}
          currentLabel="Running"
          missingLabel="Download first"
          where="the LLM server"
          empty="Unknown until the image registry answers."
          triggerRef={imagesTrigger}
        />
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
        {job && isJobActive(job) ? `${status.label} ${job.step}` : ""}
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
      const { row } = dialog;
      // Said as the button that opened it said it.
      const verb = row.image ? "Use" : "Download";
      return (
        <ConfirmDialog
          {...common}
          title={dialog.update ? `Update the LLM engine to ${row.version}?` : `${verb} LLM engine ${row.version}?`}
          confirm={dialog.update ? `Update to ${row.version}` : `${verb} ${row.version}`}
          pending="Starting…"
          onConfirm={() => updateEngine(row.version)}
        >
          {row.notes?.breaking ? (
            <span className="flex flex-col items-center gap-1.5 sm:items-start">
              <Badge variant="destructive">Breaking changes</Badge>
              <span>Read its release notes first: {em(row.version)} changes how the engine behaves.</span>
            </span>
          ) : null}
          <p>
            {row.image ? "Its image is on the LLM server already. " : "Its image downloads first, while the engine keeps serving. "}
            {drain} with {em(row.version)}.
          </p>
          <p>If it doesn&apos;t start properly, the LLM server puts {em(current)} back by itself.</p>
        </ConfirmDialog>
      );
    }
    case "restart":
      return (
        <ConfirmDialog
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
        </ConfirmDialog>
      );
    case "remove": {
      const { image } = dialog;
      return (
        <ConfirmDialog
          {...common}
          title="Remove engine image?"
          confirm="Remove"
          pending="Removing…"
          destructive
          onConfirm={() => removeEngineImage(image.digest ?? "", image.version)}
        >
          <p>
            Remove the {em(image.version ?? "unknown")} image{image.sizeBytes ? ` (${formatBytes(image.sizeBytes)})` : ""} from the LLM
            server? Using that version later downloads it again.
          </p>
        </ConfirmDialog>
      );
    }
  }
}

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
