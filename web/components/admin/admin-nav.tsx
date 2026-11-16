import { openMyWorkspace } from "@/lib/actions/admin";
import { BarMenu, BarMenuAction } from "@/components/common/bar-menu";
import { HeaderNav, NavMenuItems, type NavLink } from "@/components/layout/header-nav";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AuditIcon, OverviewIcon, PackageIcon, TerminalIcon, UsersIcon } from "@/components/ui/icons";

const LINKS: NavLink[] = [
  { href: "/admin", label: "Overview", icon: <OverviewIcon /> },
  { href: "/admin/users", label: "Users", icon: <UsersIcon />, prefix: "/admin/users/" },
  { href: "/admin/updates", label: "Updates", icon: <PackageIcon />, prefix: "/admin/agents" },
  { href: "/admin/audit", label: "Audit log", icon: <AuditIcon />, prefix: "/admin/audit" },
];

/** The console's page tabs (below `md` only the current one, as the page's name). */
export function AdminNav() {
  return <HeaderNav label="Admin" links={LINKS} />;
}

/** The admin bar's menu below `md`: the pages (the current one ticked), "My workspace" and "Sign out". */
export function AdminMenu({ name, initials }: { name: string; initials: string }) {
  return (
    <BarMenu viewer={{ name, initials }} className="md:hidden">
      <NavMenuItems links={LINKS} />
      <DropdownMenuSeparator />
      <BarMenuAction action={openMyWorkspace}>
        <TerminalIcon />
        My workspace
      </BarMenuAction>
    </BarMenu>
  );
}
