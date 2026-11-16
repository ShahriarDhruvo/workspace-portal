"use client";

import { useRef, useState } from "react";
import {
  agentStatus,
  currentImageMissing,
  defaultVersionNote,
  isJobActive,
  runningSummary,
  updateBlocker,
  type ActionContext,
} from "@/lib/agent-versions";
import type { AgentUpdateJob, AgentVersionInfo, InstalledImage } from "@/lib/gateway-types";
import { GuardedButton } from "@/components/common/guarded-button";
import { LocalTime } from "@/components/local-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { WarningIcon } from "@/components/ui/icons";
import { AgentImages } from "./agent-images";
import { AgentJob } from "./agent-job";
import { ChangeVersionDialog, RemoveImageDialog, UpdateConfirmDialog, type UpdatePlan } from "./update-dialogs";
import { useDismissedJob } from "./use-dismissed-job";
import { VersionCard, VersionSection } from "./version-card";

type AgentDialog = { kind: "update"; plan: UpdatePlan } | { kind: "change" } | { kind: "remove"; image: InstalledImage };

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
 * start with and its status, "Update to X.Y.Z" (and "Change version…" for any other), the update job inline while it
 * runs and once it has finished, and the release channels and the images on this server collapsed below. One dialog
 * at a time; it stays mounted while it closes, so its content doesn't change mid-animation. Several controls open
 * it, so it has no Trigger of its own: the card remembers which one did and the dialog hands the focus back to it
 * (to the images section's trigger once a removed image's row, and its Remove button, is gone).
 */
export function AgentCard({ agent, context, registry, onChanged }: AgentCardProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const imagesTrigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const focusHandoff = useRef(false);
  const [dialog, setDialog] = useState<AgentDialog>({ kind: "change" });
  const [open, setOpen] = useState(false);
  const [dismissedJob, dismissJob] = useDismissedJob("agents");
  const blocked = updateBlocker(context);
  const latest = agent.updateAvailable ? agent.latest : null;
  const job: AgentUpdateJob | null = context.job?.agent === agent.id ? context.job : null;
  const shownJob = job && (isJobActive(job) || (dismissedJob !== undefined && dismissedJob !== job.id)) ? job : null;

  function show(next: AgentDialog, from: HTMLElement) {
    opener.current = from;
    setDialog(next);
    setOpen(true);
  }

  const notes = [defaultVersionNote(agent), runningSummary(agent)].filter(Boolean).join(" ");
  return (
    <VersionCard
      title={agent.name}
      subtitle={agent.packageName}
      status={agentStatus(agent, context.job)}
      headingRef={heading}
      version={{ label: "New workspaces start with", value: agent.current, note: notes || null }}
      actions={
        // While this agent's job runs its panel is the focus, and nothing else can start anyway.
        job && isJobActive(job) ? null : (
          <>
            <GuardedButton variant="outline" blockedReason={blocked} onClick={(event) => show({ kind: "change" }, event.currentTarget)}>
              Change version…
            </GuardedButton>
            {latest ? (
              <GuardedButton
                blockedReason={blocked}
                onClick={(event) => show({ kind: "update", plan: { kind: "update", version: latest } }, event.currentTarget)}
              >
                Update to {latest}…
              </GuardedButton>
            ) : null}
          </>
        )
      }
      sections={
        <>
          <VersionSection title="Release channels" summary={channelSummary(agent)}>
            {agent.channels.length > 0 ? (
              <Card size="sm" className="gap-0 py-0">
                <Table className="[&_tr>*:first-child]:pl-3 [&_tr>*:last-child]:pr-3">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col" className="h-8 text-12 text-muted-foreground">
                        Channel
                      </TableHead>
                      <TableHead scope="col" className="h-8 text-12 text-muted-foreground">
                        Version
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agent.channels.map((channel) => (
                      <TableRow key={channel.tag}>
                        <TableCell>{channel.tag}</TableCell>
                        <TableCell className="font-mono text-13">{channel.version}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            ) : (
              <p className="text-13 text-muted-foreground">Unknown until the npm registry answers.</p>
            )}
          </VersionSection>
          <VersionSection
            title="Images on this server"
            summary={`${agent.installed.length} ${agent.installed.length === 1 ? "image" : "images"}`}
            triggerRef={imagesTrigger}
          >
            <AgentImages
              agent={agent}
              context={context}
              onSwitch={(image, from) => show({ kind: "update", plan: { kind: "switch", version: image.version } }, from)}
              onRebuild={(from) => show({ kind: "update", plan: { kind: "rebuild" } }, from)}
              onRemove={(image, from) => show({ kind: "remove", image }, from)}
            />
          </VersionSection>
        </>
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
                  Latest versions are as of <LocalTime at={registry.checkedAt} relative />.
                </>
              ) : (
                "Latest versions are unknown."
              )}{" "}
              Builds may fail until it answers; switching to an image on this server doesn&apos;t need it.
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
              onClick={(event) => show({ kind: "update", plan: { kind: "build" } }, event.currentTarget)}
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

      {dialog.kind === "update" ? (
        <UpdateConfirmDialog
          plan={dialog.plan}
          agent={agent}
          open={open}
          onOpenChange={setOpen}
          onDone={onChanged}
          returnFocusTo={opener}
        />
      ) : dialog.kind === "change" ? (
        <ChangeVersionDialog agent={agent} open={open} onOpenChange={setOpen} onDone={onChanged} returnFocusTo={opener} />
      ) : (
        <RemoveImageDialog
          agent={agent}
          image={dialog.image}
          open={open}
          onOpenChange={setOpen}
          onDone={() => {
            opener.current = imagesTrigger.current;
            onChanged();
          }}
          returnFocusTo={opener}
        />
      )}
    </VersionCard>
  );
}

/** "latest 0.27.4, 2 more": the channel new versions usually come from, and how many others there are. */
function channelSummary(agent: AgentVersionInfo): string {
  const shown = agent.channels.find((channel) => channel.tag === "latest") ?? agent.channels[0];
  if (!shown) return "Unknown";
  const more = agent.channels.length - 1;
  return `${shown.tag} ${shown.version}${more > 0 ? `, ${more} more` : ""}`;
}
