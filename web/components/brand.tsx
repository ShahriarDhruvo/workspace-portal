import { cn } from "@/lib/utils";

/**
 * Workspace Portal's own mark: a rounded square in the primary grey with a "W" in the on-primary colour.
 * Monochrome on purpose, so it sits in the Web Shell's neutral chrome without borrowing anyone's logo or
 * brand colour. app/icon.svg is a standalone file that can't read the theme, so it repeats the two values.
 */
export function PortalMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="shrink-0">
      <rect width="24" height="24" rx="6" className="fill-primary" />
      <path
        d="M6.25 8.25 9.1 16 12 9.75 14.9 16l2.85-7.75"
        className="stroke-primary-foreground"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** The mark and the name. `compact` (the top bars): on narrow screens only the mark shows; the name stays for screen readers. */
export function Brand({ size = "md", compact = false }: { size?: "md" | "lg"; compact?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <PortalMark size={size === "lg" ? 26 : 22} />
      <span
        className={cn(size === "lg" ? "text-18 leading-5 font-medium" : "text-14 font-semibold", compact && "max-sm:sr-only")}
      >
        Workspace Portal
      </span>
    </span>
  );
}

export function Avatar({ initials, size = "sm" }: { initials: string; size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground",
        size === "lg" ? "size-10 text-14" : "size-6 text-11",
      )}
    >
      {/* Trimmed to the cap height so the capitals sit in the optical centre of the circle. */}
      <span className="block [text-box:trim-both_cap_alphabetic]">{initials}</span>
    </span>
  );
}

/** Avatar plus full name, as shown on the right of the top bars where they show in full. */
export function UserChip({ name, initials }: { name: string; initials: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-13 text-foreground">
      <Avatar initials={initials} />
      <span className="truncate">{name}</span>
    </span>
  );
}
