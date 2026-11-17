import type { ReactNode } from "react";

/**
 * The 46px top bar every signed-in page shares (Home, Settings, the admin console, the workspace), like the Web
 * Shell's header row: one row on the background colour over a 1px rule, 20px side padding (16px on phones). The
 * portal's pages keep it on screen from AppHeader's sticky wrapper; the workspace
 * page doesn't scroll.
 */
export function HeaderBar({ children }: { children: ReactNode }) {
  return (
    <header className="flex h-11.5 shrink-0 items-center gap-3 border-b bg-background px-5 max-sm:gap-2 max-sm:px-4">
      {children}
    </header>
  );
}
