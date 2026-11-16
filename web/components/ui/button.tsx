import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

// shadcn/ui Button in the Web Shell's proportions: 32px (default), 28px (sm), 44px (lg, the auth card) or a
// 28px square (icon); a light-grey primary; focus as a border plus a 3px ring. Destructive actions are a red
// tint or a red outline, never solid red. `asChild` puts the styles on the child, e.g. a Next <Link>.
// A pending form (SubmitButton) sets data-pending: a wait cursor over a less faded look than disabled.
// On touch screens the sizes stay and the hit area grows to 40px (hit-area, app/globals.css).

const buttonVariants = cva(
  "hit-area relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border border-transparent font-medium whitespace-nowrap select-none outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 data-pending:cursor-wait data-pending:opacity-70 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline: "border-input bg-input/30 text-foreground hover:bg-input/50 aria-expanded:bg-input/50",
        ghost: "text-foreground hover:bg-accent/50 aria-expanded:bg-accent/50",
        /** Icon buttons (dialog close, row menus, dismiss): a muted glyph, a solid fill on hover, nav-style focus. */
        muted:
          "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring aria-expanded:bg-accent aria-expanded:text-foreground",
        destructive: "bg-destructive/20 text-destructive hover:bg-destructive/30",
        "destructive-outline": "border-destructive text-destructive hover:bg-destructive/10",
        /** On a danger-toned notice strip (the viewing banner): an outline in the strip's tone. */
        banner: "border-danger/20 text-danger hover:bg-danger/20",
      },
      size: {
        default: "h-8 rounded-md px-2.5 text-14",
        sm: "h-7 rounded-md px-3 text-12 [&_svg]:size-3.5",
        lg: "h-11 rounded-xl px-2.5 text-16",
        icon: "size-7 rounded-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
