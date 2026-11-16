import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { Brand, UserChip } from "@/components/brand";
import { BarMenu } from "@/components/common/bar-menu";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { SubmitButton } from "@/components/forms/submit-button";
import { HomeIcon, LogOutIcon, SettingsIcon, ShieldIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { HeaderBar } from "./header-bar";
import { HeaderNav, NavMenuItems, type NavLink } from "./header-nav";

export interface Viewer {
  name: string;
  initials: string;
  isAdmin: boolean;
}

/**
 * The top bar of the signed-in user pages (Home, Settings): the mark and name (to Home), the page links, then
 * the theme switch, who is signed in and Sign out. Below `md` a menu button holds the links and Sign out; the bar
 * keeps the mark, the current page's name and the theme switch.
 */
export function AppHeader({ viewer }: { viewer: Viewer }) {
  const links: NavLink[] = [
    { href: "/", label: "Home", icon: <HomeIcon /> },
    { href: "/settings", label: "Settings", icon: <SettingsIcon /> },
    ...(viewer.isAdmin ? [{ href: "/admin", label: "Admin", icon: <ShieldIcon />, prefix: "/admin/" }] : []),
  ];
  return (
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
        <BarMenu viewer={viewer} className="md:hidden">
          <NavMenuItems links={links} />
        </BarMenu>
      </div>
    </HeaderBar>
  );
}
