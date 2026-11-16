"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { openMyWorkspace } from "@/lib/actions/admin";
import { BarMenu, BarMenuAction } from "@/components/common/bar-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AuditIcon, CheckIcon, PackageIcon, TerminalIcon, UsersIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/admin", label: "Users", icon: <UsersIcon />, matches: (path: string) => path === "/admin" || path.startsWith("/admin/users") },
  { href: "/admin/agents", label: "Agents", icon: <PackageIcon />, matches: (path: string) => path.startsWith("/admin/agents") },
  { href: "/admin/audit", label: "Audit log", icon: <AuditIcon />, matches: (path: string) => path.startsWith("/admin/audit") },
];

/**
 * Web Shell text tabs (as on Daemon Status): muted until hovered or current; the current one gets a 2px
 * primary underline that sits on the header's bottom border. Below `md` only the current tab shows, as the
 * page's name: the others are in the menu (AdminMenu).
 */
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex shrink-0 self-stretch">
      {LINKS.map((link) => {
        const current = link.matches(pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex items-center border-b-2 px-3.5 text-13 font-medium transition-colors focus-visible:-outline-offset-2",
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

/** The admin bar's menu below `md`: the pages (the current one ticked), "My workspace" and "Sign out". */
export function AdminMenu({ name, initials }: { name: string; initials: string }) {
  const pathname = usePathname();
  return (
    <BarMenu viewer={{ name, initials }} className="ml-auto md:hidden">
      {LINKS.map((link) => {
        const current = link.matches(pathname);
        return (
          <DropdownMenuItem key={link.href} asChild>
            <Link href={link.href} aria-current={current ? "page" : undefined}>
              {link.icon}
              {link.label}
              {current ? <CheckIcon className="ml-auto" /> : null}
            </Link>
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <BarMenuAction action={openMyWorkspace}>
        <TerminalIcon />
        My workspace
      </BarMenuAction>
    </BarMenu>
  );
}
