"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuditIcon, UsersIcon } from "@/components/ui/icons";

const LINKS = [
  { href: "/admin", label: "Users", icon: <UsersIcon />, matches: (path: string) => path === "/admin" || path.startsWith("/admin/users") },
  { href: "/admin/audit", label: "Audit log", icon: <AuditIcon />, matches: (path: string) => path.startsWith("/admin/audit") },
];

/**
 * Web Shell text tabs (as on Daemon Status): muted until hovered or current; the current one gets a 2px
 * primary underline that sits on the header's bottom border. Icons stand in for the labels on narrow screens.
 */
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex self-stretch">
      {LINKS.map((link) => {
        const current = link.matches(pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3.5 text-13 font-medium transition-colors focus-visible:-outline-offset-2 ${
              current ? "border-primary text-fg" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            <span className="sm:hidden">{link.icon}</span>
            <span className="max-sm:sr-only">{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
