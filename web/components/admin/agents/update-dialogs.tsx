"use client";

import type { ReactNode, RefObject } from "react";
import { removeAgentImage, updateAgent } from "@/lib/actions/updates";
import { updateWork } from "@/lib/agent-versions";
import { formatBytes } from "@/lib/format";
import type { AgentVersionInfo, InstalledImage } from "@portal/core/wire";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Badge } from "@/components/ui/badge";

/** What a build costs, said in the confirmations. */
const BUILD_COST = "It builds an image on this server, which takes a few minutes and loads its CPU meanwhile.";
/** What switching to an image on the server costs (updateWork "switch"). */
const SWITCH_COST = "Its image is on this server, so nothing is built: the image is checked and made current in seconds.";

/**
 * What a confirmed change does: "update" is the card's "Update to X.Y.Z", "use" and "build" a Package images row's
 * Use… and Build… (the current version's Build… when its image is missing), "rebuild" the current one from scratch.
 */
export type UpdatePlan = { kind: "update" | "use" | "build"; version: string } | { kind: "rebuild" };

export type AgentDialog = { kind: "update"; plan: UpdatePlan } | { kind: "remove"; image: InstalledImage };

interface PlanCopy {
  title: string;
  version: string;
  rebuild: boolean;
  confirm: string;
  pending: string;
  body: ReactNode;
}

function planCopy(plan: UpdatePlan, agent: AgentVersionInfo): PlanCopy {
  const { name, current } = agent;
  const em = (version: string) => <span className="text-foreground">{version}</span>;
  // Said by what the gateway will do now: an image may have been built or removed since the button was drawn.
  const cost = (version: string) => (updateWork(agent, version) === "switch" ? SWITCH_COST : BUILD_COST);
  // The release notes announce breaking changes: said first, so it is read before the button.
  const breaking = (version: string) =>
    agent.releases.find((release) => release.version === version)?.notes?.breaking ? (
      <span className="flex flex-col items-center gap-1.5 sm:items-start">
        <Badge variant="destructive">Breaking changes</Badge>
        <span>Read its release notes first: {em(version)} changes how {name} behaves.</span>
      </span>
    ) : null;
  const change = (version: string) => (
    <>
      {breaking(version)}
      <p>
        New workspaces will start with {em(version)} instead of {em(current)}. {cost(version)}
      </p>
      <p>Running workspaces keep their version until they restart.</p>
    </>
  );
  if (plan.kind === "build" && plan.version === current) {
    return {
      title: `Build ${name} ${current}?`,
      version: current,
      rebuild: false,
      confirm: "Build",
      pending: "Starting…",
      body: (
        <p>
          The image of the current version is missing, so new {name} workspaces can&apos;t start. {BUILD_COST}
        </p>
      ),
    };
  }
  switch (plan.kind) {
    case "update":
      return { title: `Update ${name} to ${plan.version}?`, version: plan.version, rebuild: false, confirm: `Update to ${plan.version}`, pending: "Starting…", body: change(plan.version) };
    case "use":
      return { title: `Use ${name} ${plan.version}?`, version: plan.version, rebuild: false, confirm: `Use ${plan.version}`, pending: "Switching…", body: change(plan.version) };
    case "build":
      return { title: `Build ${name} ${plan.version}?`, version: plan.version, rebuild: false, confirm: `Build ${plan.version}`, pending: "Starting…", body: change(plan.version) };
    case "rebuild":
      return {
        title: `Rebuild ${name} ${current}?`,
        version: current,
        rebuild: true,
        confirm: "Rebuild",
        pending: "Starting…",
        body: (
          <>
            <p>
              Build {em(current)} again from scratch, without the build cache: fresh system packages (Chromium, security
              fixes) and a fresh install of {name}. This takes several minutes and loads the server&apos;s CPU meanwhile.
            </p>
            <p>Running workspaces keep the current build until they restart.</p>
          </>
        ),
      };
  }
}

interface AgentDialogsProps {
  dialog: AgentDialog;
  agent: AgentVersionInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The gateway accepted: poll now. */
  onDone: () => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}

/**
 * An agent card's confirmation: one prepared change, or removing an image. It sends the exact version on screen,
 * never a dist-tag the gateway would resolve against a fresher registry answer.
 */
export function AgentDialogs({ dialog, agent, ...common }: AgentDialogsProps) {
  if (dialog.kind === "remove") {
    const { image } = dialog;
    return (
      <ConfirmDialog
        {...common}
        apart
        title="Remove image?"
        confirm="Remove"
        pending="Removing…"
        destructive
        onConfirm={() => removeAgentImage(agent.id, image.version)}
      >
        <p>
          Remove the {agent.name} <span className="text-foreground">{image.version}</span> image ({formatBytes(image.sizeBytes)})
          from this server? Using {image.version} again later builds it first.
        </p>
      </ConfirmDialog>
    );
  }
  const copy = planCopy(dialog.plan, agent);
  return (
    <ConfirmDialog
      {...common}
      apart
      title={copy.title}
      confirm={copy.confirm}
      pending={copy.pending}
      onConfirm={() => updateAgent(agent.id, copy.version, copy.rebuild)}
    >
      {copy.body}
    </ConfirmDialog>
  );
}
