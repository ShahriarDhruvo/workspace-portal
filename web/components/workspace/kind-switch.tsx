"use client";

import type { WorkspaceKind } from "@portal/db";
import { cn } from "@/lib/utils";
import { useBlockedHint } from "@/components/common/guarded-button";
import { GlobeIcon, LockIcon } from "@/components/ui/icons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** The chosen item stands out, filled and in full contrast; the other's label is muted and only lights up on hover. */
const ITEM = "data-[state=off]:text-muted-foreground data-[state=off]:hover:bg-transparent data-[state=off]:hover:text-foreground";

interface KindSwitchProps {
  value: WorkspaceKind;
  onValueChange: (kind: WorkspaceKind) => void;
  /** Why Online can't be chosen (turned off on the portal, or not for this account); null when it can. */
  onlineBlocked: string | null;
  className?: string;
}

/**
 * The Private | Online switch next to a stopped workspace's Start: which of the user's two workspaces Start
 * starts. There is always a choice: a press on the chosen one keeps it. With Online unavailable its item looks
 * disabled but stays focusable, and its tooltip says why (on hover, focus or a press, as GuardedButton does).
 */
export function KindSwitch({ value, onValueChange, onlineBlocked, className }: KindSwitchProps) {
  const hint = useBlockedHint<HTMLButtonElement>(onlineBlocked);
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      value={value}
      onValueChange={(next) => {
        if (next === "private" || (next === "online" && !hint.blocked)) onValueChange(next);
      }}
      aria-label="Workspace"
      className={className}
    >
      <ToggleGroupItem value="private" className={ITEM}>
        <LockIcon />
        Private
      </ToggleGroupItem>
      <Tooltip {...hint.tooltip}>
        <TooltipTrigger asChild>
          {/* The trigger would put its own data-slot and data-state (the tooltip's) on the item: the item's stay. */}
          <ToggleGroupItem
            ref={hint.ref}
            value="online"
            data-slot="toggle-group-item"
            data-state={value === "online" ? "on" : "off"}
            aria-disabled={hint.blocked || undefined}
            onClick={hint.blocked ? hint.explain : undefined}
            className={cn(
              ITEM,
              hint.blocked && "cursor-not-allowed opacity-50 data-[state=off]:hover:text-muted-foreground",
            )}
          >
            <GlobeIcon />
            Online
          </ToggleGroupItem>
        </TooltipTrigger>
        {hint.blocked ? (
          <TooltipContent collisionPadding={8} className="max-w-64 text-wrap">
            {onlineBlocked}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </ToggleGroup>
  );
}
