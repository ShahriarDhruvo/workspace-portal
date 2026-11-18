import type { ReactNode } from "react";

/** The 46px top bar every signed-in page shares; AppHeader's sticky wrapper keeps it on screen. */
export function HeaderBar({ children }: { children: ReactNode }) {
  return (
    <header className="flex h-11.5 shrink-0 items-center gap-3 border-b bg-background px-5 max-sm:gap-2 max-sm:px-4">
      {children}
    </header>
  );
}
