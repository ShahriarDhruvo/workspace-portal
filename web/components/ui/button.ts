// Web Shell (shadcn/ui) button: 32px (md), 28px (sm) or 44px (lg, the auth card), light-grey primary,
// focus as a border plus a 3px ring. Destructive actions are a red tint or a red outline, never solid red.

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger" | "danger-outline" | "banner";
export type ButtonSize = "md" | "sm" | "lg";

const BASE =
  "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap " +
  "border font-medium outline-none transition-[color,background-color,border-color,box-shadow] " +
  "focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/50 active:translate-y-px " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 " +
  "data-pending:cursor-wait data-pending:opacity-70 [&_svg]:shrink-0";

const SIZES: Record<ButtonSize, string> = {
  md: "h-8 rounded-md px-2.5 text-14",
  sm: "h-7 rounded-md px-3 text-12 [&_svg]:size-3.5",
  lg: "h-11 rounded-xl px-2.5 text-16",
};

// Every variant sets its own border colour (transparent or not): a shared border-transparent in BASE would
// win over some of them, since Tailwind orders same-property utilities by name, not by class order.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-primary text-fg-on-primary hover:bg-primary/80",
  outline: "border-line-strong bg-input text-fg hover:bg-input-hover aria-expanded:bg-input-hover",
  ghost: "border-transparent text-fg hover:bg-hover aria-expanded:bg-hover",
  danger: "border-transparent bg-destructive/20 text-destructive hover:bg-destructive/30",
  "danger-outline": "border-destructive text-destructive hover:bg-destructive/10",
  /** On a tinted notice strip (the danger-toned viewing banner): an outline in the strip's tone. */
  banner: "border-danger-line text-danger hover:bg-danger-line",
};

export function buttonClass(variant: ButtonVariant = "outline", size: ButtonSize = "md", extra = ""): string {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${extra}`.trim();
}

/** 28px square icon button (dialog close, row menus): muted icon, raised fill on hover. */
export const ICON_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-muted transition-colors " +
  "hover:bg-pressed hover:text-fg aria-expanded:bg-pressed aria-expanded:text-fg";
