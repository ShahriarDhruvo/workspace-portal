import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { Brand, UserChip } from "@/components/brand";
import { BarMenu } from "@/components/common/bar-menu";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { SubmitButton } from "@/components/forms/submit-button";
import { Button } from "@/components/ui/button";
import { ArrowRightIcon, LogOutIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { PreviewButton } from "@/components/workspace/preview-button";
import { cn } from "@/lib/utils";
import { HeaderBar } from "./header-bar";
import { HeaderNav, NavMenuItems } from "./header-nav";
import { portalLinks } from "./portal-links";

export interface Viewer {
  name: string;
  initials: string;
  isAdmin: boolean;
}

/**
 * The top bar of every signed-in page but the workspace. At every width it has the way back to the workspace, which
 * is otherwise two steps away (Home, then its button), and Preview while a web server runs there. Beside those, the
 * tabs, the user and Sign out fit from `lg`, and the admin's seven tabs from `xl`: below, they are in the bar's menu.
 */
export function AppHeader({ viewer }: { viewer: Viewer }) {
  const links = portalLinks(viewer.isAdmin);
  const [wide, narrow] = viewer.isAdmin ? ["max-xl:hidden", "xl:hidden"] : ["max-lg:hidden", "lg:hidden"];
  return (
    <div className="sticky top-0 z-10 shrink-0">
      <HeaderBar>
        <Link href="/" className="hit-area relative shrink-0 rounded-sm" aria-label="Workspace Portal, Home">
          <Brand compact />
        </Link>
        <Separator orientation="vertical" className={cn("data-vertical:h-4 data-vertical:self-center", wide)} />
        <HeaderNav label="Portal" links={links} className={wide} />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <PreviewButton />
          <Button asChild variant="outline" size="sm">
            <Link href="/workspace">
              Workspace
              <ArrowRightIcon />
            </Link>
          </Button>
          <ThemeToggle />
          <div className={cn("flex min-w-0 items-center gap-2", wide)}>
            {/* Beside the admin's seven tabs the name shows from `2xl`; the avatar always. */}
            <UserChip name={viewer.name} initials={viewer.initials} nameClassName={viewer.isAdmin ? "max-2xl:sr-only" : undefined} />
            <form action={signOut}>
              <SubmitButton variant="outline" size="sm" icon={<LogOutIcon />}>
                Sign out
              </SubmitButton>
            </form>
          </div>
          <BarMenu viewer={viewer} className={narrow}>
            <NavMenuItems links={links} />
          </BarMenu>
        </div>
      </HeaderBar>
    </div>
  );
}
