import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/**
 * Workspace Portal's own mark: a rounded square in the primary colour with a "W" in the on-primary colour.
 * Monochrome on purpose, so it sits in the Web Shell's neutral chrome in either theme without borrowing anyone's
 * logo or brand colour. app/icon.svg is a standalone file that can't read the theme, so it repeats the dark
 * theme's two values.
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

/**
 * The mark and the name. In a top bar, `compact` drops the name (kept for screen readers) below the width where
 * the bar has room for it.
 */
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

/** A person's initials in a shadcn/ui Avatar (no photos in the portal), hidden from screen readers. */
export function UserAvatar({ initials, size = "sm" }: { initials: string; size?: "sm" | "lg" }) {
  return (
    <Avatar size={size} aria-hidden="true">
      <AvatarFallback className="font-medium">{initials}</AvatarFallback>
    </Avatar>
  );
}

/** Avatar plus full name, on the right of the top bars where they show in full. Cut short, the name is in its tooltip. */
export function UserChip({ name, initials, nameClassName }: { name: string; initials: string; nameClassName?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-13 text-foreground">
      <UserAvatar initials={initials} />
      <span className={cn("truncate", nameClassName)} title={name}>
        {name}
      </span>
    </span>
  );
}
