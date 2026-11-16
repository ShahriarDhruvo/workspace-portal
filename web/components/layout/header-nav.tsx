"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Page links as text tabs in a bar (the top bar's and the admin console's bar under it), the current page marked.

export interface NavLink {
  href: string;
  label: string;
  /** Shown before the label from `sm` up (the admin bar's tabs; the top bar's are text only). */
  icon?: ReactNode;
  /** Pages under this path count as this link's too (a user's page under Users). */
  prefix?: string;
}

function isCurrent(pathname: string, link: NavLink): boolean {
  return pathname === link.href || (link.prefix !== undefined && pathname.startsWith(link.prefix));
}

/**
 * Web Shell text tabs (as on Daemon Status): 13px/500, muted until hovered or current; the current one gets a
 * 2px primary underline on its bar's bottom rule.
 */
export function HeaderNav({ label, links }: { label: string; links: NavLink[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex shrink-0 self-stretch">
      {links.map((link) => {
        const current = isCurrent(pathname, link);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-13 font-medium whitespace-nowrap transition-colors focus-visible:-outline-offset-2 max-sm:px-2.5",
              current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              "[&_svg]:max-sm:hidden",
            )}
          >
            {link.icon}
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
