import { AuditIcon, EnergyIcon, HomeIcon, PackageIcon, SettingsIcon, UsageIcon, UsersIcon } from "@/components/ui/icons";
import type { NavLink } from "./header-nav";

// The portal's pages in the order the top bar shows them: Settings for everyone, then the admin's five pages.
// Home is the mark at the bar's left end; menus that have no mark list it first.

export const HOME_LINK: NavLink = { href: "/", label: "Home", icon: <HomeIcon /> };

const ADMIN_LINKS: NavLink[] = [
  { href: "/admin", label: "Usage", icon: <UsageIcon /> },
  { href: "/admin/energy", label: "Energy", icon: <EnergyIcon /> },
  { href: "/admin/users", label: "Users", icon: <UsersIcon />, prefixes: ["/admin/users/"] },
  { href: "/admin/updates", label: "Updates", icon: <PackageIcon />, prefixes: ["/admin/updates/", "/admin/agents"] },
  { href: "/admin/audit", label: "Audit log", icon: <AuditIcon />, prefixes: ["/admin/audit/"] },
];

export function portalLinks(isAdmin: boolean): NavLink[] {
  return [{ href: "/settings", label: "Settings", icon: <SettingsIcon /> }, ...(isAdmin ? ADMIN_LINKS : [])];
}
