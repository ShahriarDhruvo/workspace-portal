import Link from "next/link";
import type { ReactNode } from "react";
import { BackIcon } from "@/components/ui/icons";

/** Back chevron plus the parent page's name, muted until hovered (the Web Shell's full-page back button). */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="hit-area relative -ml-1.5 inline-flex min-h-7 w-fit items-center gap-1 rounded-lg py-0.5 pr-2 pl-1 text-13 text-muted-foreground transition-colors wrap-anywhere hover:bg-accent hover:text-foreground"
    >
      <BackIcon />
      {children}
    </Link>
  );
}
