import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The 46px top bar every signed-in page shares (Home, Settings, the admin console, the workspace), like the Web
 * Shell's header row: one row on the background colour over a 1px rule, 20px side padding (16px on phones).
 * `sticky` keeps it on screen while a page scrolls; the workspace page doesn't scroll and passes false.
 */
export function HeaderBar({ children, sticky = true }: { children: ReactNode; sticky?: boolean }) {
  return (
    <header
      className={cn(
        "flex h-11.5 shrink-0 items-center gap-3 border-b bg-background px-5 max-sm:gap-2 max-sm:px-4",
        sticky && "sticky top-0 z-10",
      )}
    >
      {children}
    </header>
  );
}
