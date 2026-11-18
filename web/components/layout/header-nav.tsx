"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// The portal's pages as links: tabs in the top bar, and the same links as items of a bar's menu (on phones, and in
// the workspace bar), each with its icon, the current page marked in both.

export interface NavLink {
  href: string;
  label: string;
  /** Before the label, in the tab and in the menu's item. */
  icon?: ReactNode;
  /** Pages under these paths count as this link's too (a user's page under Users). */
  prefixes?: string[];
}

function isCurrent(pathname: string, link: NavLink): boolean {
  return pathname === link.href || (link.prefixes ?? []).some((prefix) => pathname.startsWith(prefix));
}

/** Web Shell tabs. Below `lg` (a tablet) the icons give way so that the admin's six tabs fit the bar. */
export function HeaderNav({ label, links, className }: { label: string; links: NavLink[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={cn("flex shrink-0 self-stretch", className)}>
      {links.map((link) => {
        const current = isCurrent(pathname, link);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-13 font-medium whitespace-nowrap transition-colors focus-visible:-outline-offset-2 max-lg:px-2.5 max-lg:[&_svg]:hidden",
              current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
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

/** The same links as items of a bar's DropdownMenu, each with its icon; the current page's item is marked. */
export function NavMenuItems({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  return links.map((link) => {
    const current = isCurrent(pathname, link);
    return (
      <DropdownMenuItem key={link.href} asChild>
        <Link href={link.href} aria-current={current ? "page" : undefined} className={cn(current && "bg-accent/50 font-medium")}>
          {link.icon}
          {link.label}
        </Link>
      </DropdownMenuItem>
    );
  });
}
