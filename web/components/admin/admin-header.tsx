import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { Brand, UserChip } from "@/components/brand";
import { buttonClass } from "@/components/ui/button";
import { LogOutIcon, TerminalIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { AdminNav } from "./admin-nav";

/** The admin console's 46px top bar, like the Web Shell's full-page header (same anatomy as the workspace bar). */
export function AdminHeader({ name, initials }: { name: string; initials: string }) {
  return (
    <header className="sticky top-0 z-10 flex h-11.5 shrink-0 items-center gap-3 border-b border-line bg-base px-5">
      <Link href="/admin" className="rounded-sm">
        <Brand />
      </Link>
      <span aria-hidden="true" className="h-4 border-l border-line" />
      <AdminNav />
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <Link href="/workspace" className={buttonClass("ghost", "sm")}>
          <TerminalIcon />
          <span className="max-sm:sr-only">My workspace</span>
        </Link>
        <UserChip name={name} initials={initials} />
        <form action={signOut}>
          <SubmitButton variant="outline" size="sm" icon={<LogOutIcon />}>
            Sign out
          </SubmitButton>
        </form>
      </div>
    </header>
  );
}
