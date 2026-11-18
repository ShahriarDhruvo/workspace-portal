"use client";

import { useEffect, useState, useTransition, type ReactNode, type Ref } from "react";
import { signOut } from "@/lib/actions/auth";
import { UserAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOutIcon, MenuIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";

// A top bar's menu. Its content unmounts as soon as an item is chosen, so a form inside it would be gone before it
// submits: Sign out runs its server action from the menu instead, which stays mounted.

interface BarMenuProps {
  viewer: { name: string; initials: string };
  /** The bar's own items, between the signed-in user and "Sign out" (none: the menu only signs out). */
  children?: ReactNode;
  /** "menu": a three-line button; "avatar": the user's initials. */
  trigger?: "menu" | "avatar";
  /** Where the button sits in the bar, and from which width it is hidden. */
  className?: string;
  /** The menu button, for a dialog opened from an item to hand the focus back to. */
  ref?: Ref<HTMLButtonElement>;
}

export function BarMenu({ viewer, children, trigger = "menu", className, ref }: BarMenuProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Open while the window grows past the bar's breakpoint (a tablet turned to landscape), the menu would lose
  // its button and hang in a corner of the page. Any resize closes it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={pending}>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size={trigger === "avatar" ? "icon" : "icon-sm"}
          aria-label={trigger === "avatar" ? `Menu for ${viewer.name}` : "Menu"}
          aria-busy={pending || undefined}
          className={className}
        >
          {pending ? <Spinner aria-hidden="true" /> : trigger === "avatar" ? <UserAvatar initials={viewer.initials} /> : <MenuIcon />}
        </Button>
      </DropdownMenuTrigger>
      {/* A fixed width, so a long name wraps rather than widening the menu past a phone's screen. */}
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex items-start gap-2 text-13 font-normal text-foreground">
          <UserAvatar initials={viewer.initials} />
          <span className="sr-only">Signed in as </span>
          <span className="mt-0.5 min-w-0 wrap-anywhere">{viewer.name}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {children ? (
          <>
            {children}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => startTransition(() => signOut())}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
