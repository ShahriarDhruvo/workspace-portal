"use client";

import { useRef, useState } from "react";
import {
  agentPackageRows,
  agentStatus,
  currentImageMissing,
  removeBlocker,
  updateBlocker,
  type ActionContext,
  type AgentPackageRow,
} from "@/lib/agent-versions";
import { isJobActive } from "@/lib/update-jobs";
import type { AgentUpdateJob, AgentVersionInfo } from "@portal/core/wire";
import { GuardedButton } from "@/components/common/guarded-button";
import { LocalTime } from "@/components/local-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WarningIcon } from "@/components/ui/icons";
import { AgentJob } from "./agent-job";
import { PackageImages, type PackageImageRow } from "./package-images";
import { AgentDialogs, type AgentDialog, type UpdatePlan } from "./update-dialogs";
import { useShownJob } from "./use-dismissed-job";
import { VersionCard } from "./version-card";

const ACTION_LABELS: Record<AgentPackageRow["action"], string> = { use: "Use…", build: "Build…", rebuild: "Rebuild…" };

interface AgentCardProps {
  agent: AgentVersionInfo;
  context: ActionContext;
  /** The npm registry's last check failed: its message, and when it last answered. */
  registry: { error: string | null; checkedAt: number | null };
  /** An action was accepted, or the job changed: poll now. */
  onChanged: () => void;
}

/**
 * One enabled agent on the Updates page, in the same layout as the LLM engine's card: the version new workspaces
 * start with and its status, "Update to X.Y.Z" when latest is newer, the update job inline while it runs and once
 * it has finished, and the Package images below (each row's Use…, Build…, Rebuild…, Remove…). One dialog at a
 * time; it stays mounted while it closes, so its content doesn't change mid-animation. Several controls open it,
 * so it has no Trigger of its own: the card remembers which one did and the dialog hands the focus back to it (to
 * the section's trigger once a removed image's row, and its Remove button, is gone).
 */
export function AgentCard({ agent, context, registry, onChanged }: AgentCardProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const imagesTrigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const focusHandoff = useRef(false);
  const [dialog, setDialog] = useState<AgentDialog>({ kind: "update", plan: { kind: "rebuild" } });
  const [open, setOpen] = useState(false);
  const blocked = updateBlocker(context);
  const latest = agent.updateAvailable ? agent.latest : null;
  const job: AgentUpdateJob | null = context.job?.agent === agent.id ? context.job : null;
  const [shownJob, dismissJob] = useShownJob("agents", job);

  function show(next: AgentDialog, from: HTMLElement) {
    opener.current = from;
    setDialog(next);
    setOpen(true);
  }

  const rows = agentPackageRows(agent).map((row): PackageImageRow => {
    const plan: UpdatePlan = row.action === "rebuild" ? { kind: "rebuild" } : { kind: row.action, version: row.version };
    const image = row.image;
    return {
      ...row,
      image,
      inUse: image?.inUse ?? 0,
      action: { label: ACTION_LABELS[row.action], blockedReason: blocked, onClick: (from) => show({ kind: "update", plan }, from) },
      remove:
        image && !row.current
          ? { label: "Remove…", blockedReason: removeBlocker(context, agent, image), onClick: (from) => show({ kind: "remove", image }, from) }
          : null,
    };
  });

  return (
    <VersionCard
      title={agent.name}
      subtitle={agent.packageName}
      status={agentStatus(agent, context.job)}
      headingRef={heading}
      version={{ label: "New workspaces start with", value: agent.current }}
      actions={
        // While this agent's job runs its panel is the focus, and nothing else can start anyway.
        latest && !(job && isJobActive(job)) ? (
          <GuardedButton
            blockedReason={blocked}
            onClick={(event) => show({ kind: "update", plan: { kind: "update", version: latest } }, event.currentTarget)}
          >
            Update to {latest}…
          </GuardedButton>
        ) : null
      }
      sections={
        <PackageImages
          name={agent.name}
          rows={rows}
          currentLabel="Current"
          missingLabel="Build first"
          where="this server"
          workspaces
          empty="Unknown until the npm registry answers."
          triggerRef={imagesTrigger}
        />
      }
    >
      {registry.error ? (
        <Alert variant="warning" role="status">
          <WarningIcon />
          <AlertTitle className="line-clamp-none">The npm registry can&apos;t be reached</AlertTitle>
          <AlertDescription>
            <p>
              {registry.error}{" "}
              {registry.checkedAt ? (
                <>
                  Versions are as of <LocalTime at={registry.checkedAt} relative />.
                </>
              ) : (
                "Versions are unknown."
              )}{" "}
              Builds may fail until it answers; using an image on this server doesn&apos;t need it.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {currentImageMissing(agent) ? (
        <Alert variant="warning">
          <WarningIcon />
          <AlertTitle className="line-clamp-none">The image of {agent.current} is missing</AlertTitle>
          <AlertDescription>
            <p>New {agent.name} workspaces can&apos;t start until it is built again.</p>
            <GuardedButton
              size="sm"
              variant="outline"
              blockedReason={blocked}
              onClick={(event) => show({ kind: "update", plan: { kind: "build", version: agent.current } }, event.currentTarget)}
            >
              Build {agent.current}…
            </GuardedButton>
          </AlertDescription>
        </Alert>
      ) : null}
      {shownJob ? (
        <AgentJob
          key={shownJob.id}
          job={shownJob}
          agent={agent}
          onChanged={onChanged}
          focusHandoff={focusHandoff}
          onDismiss={() => {
            heading.current?.focus();
            dismissJob(shownJob.id);
          }}
        />
      ) : null}

      <AgentDialogs
        dialog={dialog}
        agent={agent}
        open={open}
        onOpenChange={setOpen}
        onDone={() => {
          // The removed image's row, and its Remove button, is gone.
          if (dialog.kind === "remove") opener.current = imagesTrigger.current;
          onChanged();
        }}
        returnFocusTo={opener}
      />
    </VersionCard>
  );
}
