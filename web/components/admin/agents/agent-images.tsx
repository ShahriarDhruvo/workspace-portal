"use client";

import type { RefObject } from "react";
import { channelTags, removeBlocker, updateBlocker, type ActionContext } from "@/lib/agent-versions";
import { formatBytes } from "@/lib/format";
import type { AgentVersionInfo, InstalledImage } from "@/lib/gateway-types";
import { GuardedButton } from "@/components/common/guarded-button";
import { CardRow } from "@/components/layout/card-row";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";

interface AgentImagesProps {
  agent: AgentVersionInfo;
  context: ActionContext;
  /** The list's heading, which takes the focus once a removed image's row is gone. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Each gets the button that asked, for the dialog to return the focus to. */
  onSwitch: (image: InstalledImage, from: HTMLElement) => void;
  onRebuild: (from: HTMLElement) => void;
  onRemove: (image: InstalledImage, from: HTMLElement) => void;
}

/**
 * The agent's workspace images on this server, newest version first: size, build time, how many workspaces use
 * each. The current one can be rebuilt from scratch; any other can become current again ("Use": a switch to that
 * image, which the gateway checks and makes current in seconds, without a build or the npm registry) or be removed
 * once nothing uses it.
 */
export function AgentImages({ agent, context, headingRef, onSwitch, onRebuild, onRemove }: AgentImagesProps) {
  const blocked = updateBlocker(context);
  return (
    <div className="border-t border-border-faint">
      <h3 ref={headingRef} tabIndex={-1} className="label-caps px-3.5 pt-3 pb-1 outline-none">
        Images on this server
      </h3>
      {agent.installed.length === 0 ? (
        <p className="px-3.5 pb-3 text-13 text-muted-foreground">None.</p>
      ) : (
        agent.installed.map((image) => (
          <CardRow
            key={image.version}
            title={<ImageTitle agent={agent} image={image} />}
            action={
              <>
                {image.current ? (
                  <GuardedButton variant="outline" size="sm" blockedReason={blocked} onClick={(event) => onRebuild(event.currentTarget)}>
                    Rebuild…
                  </GuardedButton>
                ) : (
                  <GuardedButton variant="outline" size="sm" blockedReason={blocked} onClick={(event) => onSwitch(image, event.currentTarget)}>
                    Use…
                  </GuardedButton>
                )}
                <GuardedButton
                  variant="outline"
                  size="sm"
                  blockedReason={removeBlocker(context, agent, image)}
                  onClick={(event) => onRemove(image, event.currentTarget)}
                >
                  Remove…
                </GuardedButton>
              </>
            }
          >
            {formatBytes(image.sizeBytes)} · built <LocalTime at={image.createdAt} relative /> ·{" "}
            {image.inUse > 0 ? `${image.inUse} running` : "not in use"}
          </CardRow>
        ))
      )}
    </div>
  );
}

function ImageTitle({ agent, image }: { agent: AgentVersionInfo; image: InstalledImage }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-13 break-all">{image.version}</span>
      {image.current ? <Badge>Current</Badge> : null}
      {channelTags(agent, image.version).map((tag) => (
        <Badge key={tag} variant="outline">
          {tag}
        </Badge>
      ))}
    </span>
  );
}
