import Link from "next/link";
import type { ReactNode } from "react";
import { exitWorkspace } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/forms/submit-button";
import { Button } from "@/components/ui/button";
import { EyeIcon } from "@/components/ui/icons";

/**
 * Red-tinted notice strip (the Web Shell's notice bar in the danger tone) shown while an admin's session is
 * pointed at someone else's workspace.
 */
export function ViewingBanner({ children, returnHref }: { children: ReactNode; returnHref?: string }) {
  return (
    <div
      role="status"
      className="flex min-h-9 shrink-0 items-center gap-2.5 border-b border-danger/20 bg-danger/8 px-5 py-1.5 text-13 font-medium text-danger"
    >
      <EyeIcon className="shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {returnHref ? (
          <Button asChild variant="banner" size="sm" className="h-6">
            <Link href={returnHref}>Return to it</Link>
          </Button>
        ) : null}
        <form action={exitWorkspace}>
          <SubmitButton variant="banner" size="sm" className="h-6">
            Exit
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
