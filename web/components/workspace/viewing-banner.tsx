import Link from "next/link";
import type { ReactNode } from "react";
import { exitWorkspace } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/forms/submit-button";
import { Button } from "@/components/ui/button";
import { EyeIcon } from "@/components/ui/icons";

/** The notice strip shown while an admin's session is pointed at someone else's workspace. */
export function ViewingBanner({ children, returnHref }: { children: ReactNode; returnHref?: string }) {
  return (
    <div
      role="status"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-danger/20 bg-danger/8 px-5 py-1.5 text-13 font-medium text-danger max-sm:px-4"
    >
      <div className="flex min-w-0 flex-1 basis-48 gap-2.5">
        <EyeIcon className="mt-0.5 shrink-0" />
        <span className="min-w-0 wrap-anywhere">{children}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {returnHref ? (
          <Button asChild variant="destructive" size="xs">
            <Link href={returnHref}>Return to it</Link>
          </Button>
        ) : null}
        <form action={exitWorkspace}>
          <SubmitButton variant="destructive" size="xs">
            Exit
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
