import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BackIcon } from "@/components/ui/icons";

/** Back chevron plus the parent page's name, a muted ghost button (the Web Shell's full-page back button). */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit max-w-full text-muted-foreground">
      <Link href={href}>
        <BackIcon />
        <span className="truncate">{children}</span>
      </Link>
    </Button>
  );
}
