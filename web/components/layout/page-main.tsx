import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Content widths: sm for a page of one or two cards (Home), md for forms and pages of narrow tables (Settings, API,
 * Energy), lg for the admin console's wide tables, and wide for Usage, which grows into the margins of a wide desktop
 * (3xl, 2048px) to show its cards side by side.
 */
const WIDTHS = { sm: "max-w-[560px]", md: "max-w-[760px]", lg: "max-w-[1200px]", wide: "max-w-[1200px] 3xl:max-w-[2400px]" } as const;

export type PageWidth = keyof typeof WIDTHS;

/**
 * The body of every page under the top bar, and of its loading skeleton (loading.tsx), so both sit in the same
 * place: centred across, starting at the top. Only a narrow page (sm) is also centred down while it is shorter than
 * the screen: the others' skeletons are shorter than their pages, which would jump up when the data arrives. Its
 * children are a column with a 24px gap.
 */
export function PageMain({ width, className, children }: { width: PageWidth; className?: string; children: ReactNode }) {
  return (
    <main className={cn("flex flex-1 flex-col px-5 py-8 max-sm:px-4 max-sm:py-6", width === "wide" && "3xl:px-8")}>
      <div className={cn("mx-auto flex w-full min-w-0 flex-col gap-6", width === "sm" && "my-auto", WIDTHS[width], className)}>{children}</div>
    </main>
  );
}
