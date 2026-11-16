"use client";

import { useId, useRef, useState } from "react";
import {
  currentImageMissing,
  defaultVersionNote,
  runningSummary,
  updateBlocker,
  versionStatus,
  type ActionContext,
} from "@/lib/agent-versions";
import type { AgentVersionInfo, InstalledImage } from "@/lib/gateway-types";
import { GuardedButton } from "@/components/common/guarded-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { WarningIcon } from "@/components/ui/icons";
import { AgentImages } from "./agent-images";
import { ChangeVersionDialog, RemoveImageDialog, UpdateConfirmDialog, type UpdatePlan } from "./update-dialogs";

type AgentDialog = { kind: "update"; plan: UpdatePlan } | { kind: "change" } | { kind: "remove"; image: InstalledImage };

interface AgentCardProps {
  agent: AgentVersionInfo;
  context: ActionContext;
  /** An action was accepted: poll now. */
  onChanged: () => void;
}

/**
 * One enabled agent: its package, the current version and how it compares to the latest release, which versions
 * running workspaces use, the images on the server, and the actions that change the version. One dialog at a time;
 * it stays mounted while it closes, so its content doesn't change mid-animation. Several controls open it, so it
 * has no Trigger of its own: the card remembers which one did and the dialog hands the focus back to it (to the
 * images heading once a removed image's row, and its Remove button, is gone).
 */
export function AgentCard({ agent, context, onChanged }: AgentCardProps) {
  const titleId = useId();
  const imagesHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<AgentDialog>({ kind: "change" });
  const [open, setOpen] = useState(false);
  const blocked = updateBlocker(context);
  const latest = agent.updateAvailable ? agent.latest : null;

  function show(next: AgentDialog, from: HTMLElement) {
    opener.current = from;
    setDialog(next);
    setOpen(true);
  }

  return (
    <Card variant="outline" role="region" aria-labelledby={titleId} className="gap-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-3.5 pt-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="text-16 font-medium">
            {agent.name}
          </h2>
          <span className="font-mono text-12 break-all text-muted-foreground">{agent.packageName}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pointer-coarse:gap-y-3">
          {latest ? (
            <GuardedButton
              size="sm"
              blockedReason={blocked}
              onClick={(event) => show({ kind: "update", plan: { kind: "update", version: latest } }, event.currentTarget)}
            >
              Update to {latest}…
            </GuardedButton>
          ) : null}
          <GuardedButton size="sm" variant="outline" blockedReason={blocked} onClick={(event) => show({ kind: "change" }, event.currentTarget)}>
            Change version…
          </GuardedButton>
        </div>
      </div>

      <CurrentVersion agent={agent} />

      {currentImageMissing(agent) ? (
        <div className="px-3.5 pb-3.5">
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
        </div>
      ) : null}

      <AgentImages
        agent={agent}
        context={context}
        headingRef={imagesHeading}
        onSwitch={(image, from) => show({ kind: "update", plan: { kind: "switch", version: image.version } }, from)}
        onRebuild={(from) => show({ kind: "update", plan: { kind: "rebuild" } }, from)}
        onRemove={(image, from) => show({ kind: "remove", image }, from)}
      />

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
            opener.current = imagesHeading.current;
            onChanged();
          }}
          returnFocusTo={opener}
        />
      )}
    </Card>
  );
}

/**
 * The version new workspaces start with, prominent, with its status against the registry and what runs; beside it
 * (below, when narrow) the release channels npm offers.
 */
function CurrentVersion({ agent }: { agent: AgentVersionInfo }) {
  const status = versionStatus(agent);
  const notes = ["New workspaces start with this version.", defaultVersionNote(agent), runningSummary(agent)].filter(Boolean);
  return (
    <div className="flex flex-wrap items-start gap-x-10 gap-y-3 px-3.5 pt-3 pb-3.5">
      <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1">
        <div className="label-caps">Current version</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-mono text-22 font-bold break-all tabular-nums">{agent.current}</span>
          <Badge variant={status.tone}>{status.label}</Badge>
        </div>
        <p className="text-13 text-muted-foreground">{notes.join(" ")}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="label-caps">Release channels</div>
        {agent.channels.length > 0 ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-13">
            {agent.channels.map((channel) => (
              <div key={channel.tag} className="contents">
                <dt className="text-muted-foreground">{channel.tag}</dt>
                <dd className="font-mono break-all">{channel.version}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-13 text-muted-foreground">Unknown until the npm registry answers.</p>
        )}
      </div>
    </div>
  );
}
