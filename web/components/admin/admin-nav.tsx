"use client";

import { usePathname } from "next/navigation";
import { HeaderNav, type NavLink } from "@/components/layout/header-nav";
import { AuditIcon, PackageIcon, UsageIcon, UsersIcon } from "@/components/ui/icons";

const LINKS: NavLink[] = [
  { href: "/admin", label: "Usage", icon: <UsageIcon /> },
  { href: "/admin/users", label: "Users", icon: <UsersIcon />, prefix: "/admin/users/" },
  { href: "/admin/updates", label: "Updates", icon: <PackageIcon />, prefix: "/admin/agents" },
  { href: "/admin/audit", label: "Audit log", icon: <AuditIcon />, prefix: "/admin/audit" },
];

/**
 * The admin console's own bar, under the top bar on /admin pages only (and only ever rendered for the admin):
 * its pages as tabs. It scrolls sideways when a phone is too narrow for all four.
 */
export function AdminNav() {
  const pathname = usePathname();
  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return null;
  return (
    <div className="flex h-10 shrink-0 overflow-x-auto border-b bg-background px-2 [scrollbar-width:none] max-sm:px-1.5">
      <HeaderNav label="Admin" links={LINKS} />
    </div>
  );
}
