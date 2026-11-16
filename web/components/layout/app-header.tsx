import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { AdminNav } from "@/components/admin/admin-nav";
import { Brand, UserChip } from "@/components/brand";
import { BarMenu } from "@/components/common/bar-menu";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { SubmitButton } from "@/components/forms/submit-button";
import { LogOutIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { HeaderBar } from "./header-bar";
import { HeaderNav, type NavLink } from "./header-nav";

export interface Viewer {
  name: string;
  initials: string;
  isAdmin: boolean;
}

/**
 * The top bar of every signed-in page but the workspace: the mark and name (to Home), Settings and, for the admin,
 * Admin; then the theme switch, who is signed in and Sign out (below `md` in a menu). On /admin pages the admin
 * console's own bar (AdminNav) sits under it; both stay on screen while the page scrolls.
 */
export function AppHeader({ viewer }: { viewer: Viewer }) {
  const links: NavLink[] = [
    { href: "/settings", label: "Settings" },
    ...(viewer.isAdmin ? [{ href: "/admin", label: "Admin", prefix: "/admin/" }] : []),
  ];
  return (
    <div className="sticky top-0 z-10 shrink-0">
      <HeaderBar>
        <Link href="/" className="hit-area relative shrink-0 rounded-sm" aria-label="Workspace Portal, Home">
          <Brand compact />
        </Link>
        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
        <HeaderNav label="Portal" links={links} />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <ThemeToggle />
          <div className="flex min-w-0 items-center gap-2 max-md:hidden">
            <UserChip name={viewer.name} initials={viewer.initials} />
            <form action={signOut}>
              <SubmitButton variant="outline" size="sm" icon={<LogOutIcon />}>
                Sign out
              </SubmitButton>
            </form>
          </div>
          <BarMenu viewer={viewer} className="md:hidden" />
        </div>
      </HeaderBar>
      {viewer.isAdmin ? <AdminNav /> : null}
    </div>
  );
}
