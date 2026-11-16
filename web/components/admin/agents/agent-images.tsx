"use client";

import { channelTags, removeBlocker, updateBlocker, type ActionContext } from "@/lib/agent-versions";
import { formatBytes } from "@/lib/format";
import type { AgentVersionInfo, InstalledImage } from "@/lib/gateway-types";
import { GuardedButton } from "@/components/common/guarded-button";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const TABLE = "[&_tr>*:first-child]:pl-3 [&_tr>*:last-child]:pr-3";
const HEAD = "h-8 text-12 text-muted-foreground";

interface AgentImagesProps {
  agent: AgentVersionInfo;
  context: ActionContext;
  /** Each gets the button that asked, for the dialog to return the focus to. */
  onSwitch: (image: InstalledImage, from: HTMLElement) => void;
  onRebuild: (from: HTMLElement) => void;
  onRemove: (image: InstalledImage, from: HTMLElement) => void;
}

/**
 * The agent's workspace images on this server, newest version first, as a table that scrolls sideways inside its
 * card on a narrow screen: size, build time, how many workspaces use each. The current one can be rebuilt from
 * scratch; any other can become current again ("Use": a switch to that image, which the gateway checks and makes
 * current in seconds, without a build or the npm registry) or be removed once nothing uses it.
 */
export function AgentImages({ agent, context, onSwitch, onRebuild, onRemove }: AgentImagesProps) {
  const blocked = updateBlocker(context);
  if (agent.installed.length === 0) return <p className="text-13 text-muted-foreground">None.</p>;
  return (
    <Card size="sm" className="gap-0 py-0">
      <Table className={TABLE}>
        <TableHeader>
          <TableRow>
            {["Version", "Size", "Built", "In use"].map((heading) => (
              <TableHead key={heading} scope="col" className={HEAD}>
                {heading}
              </TableHead>
            ))}
            <TableHead scope="col" className={HEAD}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agent.installed.map((image) => (
            <TableRow key={image.version}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-13">{image.version}</span>
                  {image.current ? <Badge>Current</Badge> : null}
                  {channelTags(agent, image.version).map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatBytes(image.sizeBytes)}</TableCell>
              <TableCell className="text-muted-foreground">
                <LocalTime at={image.createdAt} relative />
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {image.inUse > 0 ? `${image.inUse} running` : "Not in use"}
              </TableCell>
              <TableCell className="w-0">
                <span className="flex justify-end gap-2">
                  {image.current ? (
                    <GuardedButton variant="outline" size="sm" blockedReason={blocked} onClick={(event) => onRebuild(event.currentTarget)}>
                      Rebuild…
                    </GuardedButton>
                  ) : (
                    <GuardedButton
                      variant="outline"
                      size="sm"
                      blockedReason={blocked}
                      onClick={(event) => onSwitch(image, event.currentTarget)}
                    >
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
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
