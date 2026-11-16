"use client";

import { createContext, use, useEffect, useState, useTransition, type ComponentProps, type ReactNode, type Ref } from "react";
import { signOut } from "@/lib/actions/auth";
import { Avatar } from "@/components/brand";
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

// The top bars' menu on screens too narrow for the full bar: a three-line button at the right end of the bar
// that opens a DropdownMenu with who is signed in, the bar's own items, then "Sign out". Each bar hides it
// from the width where its full row of controls fits (className).
// The menu's content unmounts as soon as an item is chosen, so a form inside it would be gone before it
// submits. An item that runs a server action (BarMenuAction) hands it to the menu instead, which stays
// mounted: it runs the action and shows a spinner on its button until the action's redirect arrives.

type ServerAction = () => Promise<void>;

const RunAction = createContext<(action: ServerAction) => void>(() => {});

interface BarMenuProps {
  viewer: { name: string; initials: string };
  /** The bar's own items, between the signed-in user and "Sign out". */
  children: ReactNode;
  /** Where the button sits in the bar, and from which width it is hidden. */
  className?: string;
  /** The menu button, for a dialog opened from an item to hand the focus back to. */
  ref?: Ref<HTMLButtonElement>;
}

export function BarMenu({ viewer, children, className, ref }: BarMenuProps) {
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
    <RunAction value={(action) => startTransition(() => action())}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild disabled={pending}>
          <Button
            ref={ref}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Menu"
            data-pending={pending ? "" : undefined}
            aria-busy={pending || undefined}
            className={className}
          >
            {pending ? <Spinner aria-hidden="true" /> : <MenuIcon />}
          </Button>
        </DropdownMenuTrigger>
        {/* A fixed width, so a long name wraps rather than widening the menu past a phone's screen. */}
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="flex items-start gap-2 text-13 font-normal text-foreground">
            <Avatar initials={viewer.initials} />
            <span className="sr-only">Signed in as </span>
            <span className="mt-0.5 min-w-0 wrap-anywhere">{viewer.name}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {children}
          <DropdownMenuSeparator />
          <BarMenuAction action={signOut}>
            <LogOutIcon />
            Sign out
          </BarMenuAction>
        </DropdownMenuContent>
      </DropdownMenu>
    </RunAction>
  );
}

/** A menu item for what the full bar does with a form and a submit button: it runs a server action. */
export function BarMenuAction({
  action,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuItem>, "asChild" | "onSelect"> & { action: ServerAction }) {
  const run = use(RunAction);
  return <DropdownMenuItem onSelect={() => run(action)} {...props} />;
}
