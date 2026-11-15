// cn(): joins class names and resolves Tailwind conflicts (the later class wins), as every shadcn/ui component
// expects. tailwind-merge only knows Tailwind's default theme, so it is told about the portal's own type scale
// (app/globals.css): without that, `text-13` reads as a text colour and cn("text-13 text-muted-foreground")
// drops it. Pure module (no React, no "@/" imports) so it can be unit tested with `node --test`.
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The `--text-*` sizes defined in app/globals.css. */
const TEXT_SIZES = ["11", "12", "13", "14", "16", "18", "22", "24"];

const twMerge = extendTailwindMerge({
  extend: { theme: { text: TEXT_SIZES } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
