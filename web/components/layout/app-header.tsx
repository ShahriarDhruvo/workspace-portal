import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { Brand, UserChip } from "@/components/brand";
import { BarMenu } from "@/components/common/bar-menu";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { SubmitButton } from "@/components/forms/submit-button";
import { LogOutIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { HeaderBar } from "./header-bar";
import { HeaderNav, NavMenuItems } from "./header-nav";
import { portalLinks } from "./portal-links";

export interface Viewer {
  name: string;
  initials: string;
  isAdmin: boolean;
}

/**
 * The one top bar of every signed-in page but the workspace: the mark and name (to Home), the page tabs (Settings,
 * and for the admin Usage, Energy, Users, Updates and Audit log), then the theme switch, who is signed in and Sign out.
 * Below `md` the tabs, the user and Sign out move into the bar's menu. It stays on screen while the page scrolls.
 */
export function AppHeader({ viewer }: { viewer: Viewer }) {
  const links = portalLinks(viewer.isAdmin);
  return (
    <div className="sticky top-0 z-10 shrink-0">
      <HeaderBar>
        <Link href="/" className="hit-area relative shrink-0 rounded-sm" aria-label="Workspace Portal, Home">
          <Brand compact />
        </Link>
        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center max-md:hidden" />
        <HeaderNav label="Portal" links={links} className="max-md:hidden" />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <ThemeToggle />
          <div className="flex min-w-0 items-center gap-2 max-md:hidden">
            {/* With the admin's six tabs and their icons, the name shows from `xl`; the avatar always. */}
            <UserChip name={viewer.name} initials={viewer.initials} nameClassName={viewer.isAdmin ? "max-xl:sr-only" : undefined} />
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
    </div>
  );
}
