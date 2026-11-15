"use client";

import { useRef, useState, type ComponentProps, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface GuardedButtonProps extends Omit<ComponentProps<typeof Button>, "asChild" | "disabled" | "ref"> {
  /** Why the action can't run right now; null or undefined when it can. */
  blockedReason?: string | null;
}

/**
 * A Button that can be unavailable for a reason. Blocked, it looks disabled but stays focusable (aria-disabled
 * rather than disabled), ignores clicks, and a tooltip on hover and keyboard focus says why. It is the same
 * element either way, so it keeps the focus when it becomes blocked (a job starting after its dialog closed).
 */
export function GuardedButton({ blockedReason, className, onClick, ...props }: GuardedButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  // The reason the pointer or the keyboard asked about. Only a hover or a visible (keyboard) focus while blocked
  // asks: the focus a dialog hands back after a click doesn't, nor a button becoming blocked under the focus.
  const [hintFor, setHintFor] = useState<string | null>(null);
  const blocked = Boolean(blockedReason);
  const ignore = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();
  return (
    <Tooltip
      open={blocked && hintFor === blockedReason}
      onOpenChange={(open) => {
        const asked = open && button.current?.matches(":hover, :focus-visible");
        setHintFor(asked ? (blockedReason ?? null) : null);
      }}
    >
      <TooltipTrigger asChild>
        <Button
          ref={button}
          {...props}
          aria-disabled={blocked || undefined}
          onClick={blocked ? ignore : onClick}
          className={cn(blocked && "cursor-not-allowed opacity-50 active:translate-y-0", className)}
        />
      </TooltipTrigger>
      {blocked ? (
        <TooltipContent collisionPadding={8} className="max-w-64 text-wrap">
          {blockedReason}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
