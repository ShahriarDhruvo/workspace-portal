"use client";

import { useRef, useState, type ComponentProps, type MouseEvent, type Ref } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface GuardedButtonProps extends Omit<ComponentProps<typeof Button>, "asChild" | "disabled" | "ref"> {
  /** Why the action can't run right now; null or undefined when it can. */
  blockedReason?: string | null;
  /** The button element, e.g. for a dialog to hand the focus back to. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The tooltip of GuardedButton, a control that can be unavailable for a reason: spread `tooltip` on its Tooltip,
 * put `ref` on the control and call `explain` from its click while blocked. Only a hover, a visible (keyboard)
 * focus or a press while blocked asks: the focus a dialog hands back after a click doesn't, nor a control becoming
 * blocked under the focus. `explain` prevents the click's default,
 * so the tooltip doesn't take the press as its cue to close.
 */
function useBlockedHint(blockedReason: string | null | undefined) {
  const ref = useRef<HTMLButtonElement>(null);
  // The reason the pointer or the keyboard asked about.
  const [hintFor, setHintFor] = useState<string | null>(null);
  const blocked = Boolean(blockedReason);
  return {
    ref,
    blocked,
    tooltip: {
      open: blocked && hintFor === blockedReason,
      onOpenChange: (open: boolean) => {
        const asked = open && ref.current?.matches(":hover, :focus-visible");
        setHintFor(asked ? (blockedReason ?? null) : null);
      },
    },
    explain: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      setHintFor(blockedReason ?? null);
    },
  };
}

/**
 * A Button that can be unavailable for a reason. Blocked, it looks disabled but stays focusable (aria-disabled
 * rather than disabled) and does nothing, and a tooltip says why: on hover, on keyboard focus, and when it is
 * pressed anyway, which is how a touch screen asks. It is the same element either way, so it keeps the focus
 * when it becomes blocked (a job starting after its dialog closed).
 */
export function GuardedButton({ blockedReason, className, onClick, ref, ...props }: GuardedButtonProps) {
  const hint = useBlockedHint(blockedReason);
  return (
    <Tooltip {...hint.tooltip}>
      <TooltipTrigger asChild>
        <Button
          ref={(node) => {
            hint.ref.current = node;
            if (typeof ref === "function") return ref(node);
            if (ref) ref.current = node;
          }}
          {...props}
          aria-disabled={hint.blocked || undefined}
          onClick={hint.blocked ? hint.explain : onClick}
          className={cn(hint.blocked && "cursor-not-allowed opacity-50 active:translate-y-0", className)}
        />
      </TooltipTrigger>
      {hint.blocked ? (
        <TooltipContent collisionPadding={8} className="max-w-64 text-wrap">
          {blockedReason}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
