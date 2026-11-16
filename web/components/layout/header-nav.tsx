"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { CheckIcon } from "@/components/ui/icons";

// The top bars' page links, in two forms: text tabs in the bar from `md`, and menu items for the bar's menu
// below it. Both mark the current page.

export interface NavLink {
  href: string;
  label: string;
  icon: ReactNode;
  /** Pages under this path count as this link's too (a user's page under Users). */
  prefix?: string;
}

function isCurrent(pathname: string, link: NavLink): boolean {
  return pathname === link.href || (link.prefix !== undefined && pathname.startsWith(link.prefix));
}

/**
 * Web Shell text tabs (as on Daemon Status): 13px/500, muted until hovered or current; the current one gets a
 * 2px primary underline on the bar's bottom rule. Below `md` only the current one shows, as the page's name.
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
              "-mb-px inline-flex items-center border-b-2 px-3 text-13 font-medium transition-colors focus-visible:-outline-offset-2",
              current
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground max-md:hidden",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The same links as items of the bar's menu (below `md`), the current one ticked. */
export function NavMenuItems({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  return links.map((link) => {
    const current = isCurrent(pathname, link);
    return (
      <DropdownMenuItem key={link.href} asChild>
        <Link href={link.href} aria-current={current ? "page" : undefined}>
          {link.icon}
          {link.label}
          {current ? <CheckIcon className="ml-auto" /> : null}
        </Link>
      </DropdownMenuItem>
    );
  });
}
