import Link from "next/link";
import { openMyWorkspace } from "@/lib/actions/admin";
import { signOut } from "@/lib/actions/auth";
import { Brand, UserChip } from "@/components/brand";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { SubmitButton } from "@/components/forms/submit-button";
import { HeaderBar } from "@/components/layout/header-bar";
import { LogOutIcon, TerminalIcon } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { AdminMenu, AdminNav } from "./admin-nav";

/**
 * The admin console's top bar, the same bar as Home's and Settings' (components/layout/app-header.tsx) with the
 * console's pages. Below `md` it keeps the mark, the current page's tab and the theme switch, and a menu button
 * (AdminMenu) holds the rest.
 */
export function AdminHeader({ name, initials }: { name: string; initials: string }) {
  return (
    <HeaderBar>
      <Link href="/admin" className="hit-area relative shrink-0 rounded-sm" aria-label="Workspace Portal, Admin">
        <Brand compact />
      </Link>
      <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
      <AdminNav />
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {/* An action, not a link: a session viewing someone's workspace must leave it first, and this
            layout can be stale about that after client navigation. */}
        <form action={openMyWorkspace} className="max-md:hidden">
          <SubmitButton variant="ghost" size="sm" icon={<TerminalIcon />} title="My workspace" className="max-lg:px-2">
            <span className="max-lg:sr-only">My workspace</span>
          </SubmitButton>
        </form>
        <ThemeToggle />
        <div className="flex min-w-0 items-center gap-2 max-md:hidden">
          {/* The name (and My workspace's label) only from lg: with the console's four tabs the bar wouldn't fit at md. */}
          <UserChip name={name} initials={initials} nameClassName="max-lg:sr-only" />
          <form action={signOut}>
            <SubmitButton variant="outline" size="sm" icon={<LogOutIcon />}>
              Sign out
            </SubmitButton>
          </form>
        </div>
        <AdminMenu name={name} initials={initials} />
      </div>
    </HeaderBar>
  );
}
