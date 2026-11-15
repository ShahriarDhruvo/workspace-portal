import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

// shadcn/ui Badge as the Web Shell's pill: 20px, 12px/500. Status tones are the tone's text on a 14% tint of
// itself, as on the Daemon Status page; "default" is the light-grey primary, "outline" a 1px border. The lg
// size is the top bar's status pill (24px, with a dot or a 14px icon).

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center overflow-hidden rounded-full font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        outline: "border text-muted-foreground",
        neutral: "bg-muted-foreground/14 text-muted-foreground",
        success: "bg-success/14 text-success",
        warning: "bg-warning/14 text-warning",
        danger: "bg-danger/14 text-danger",
      },
      size: {
        default: "h-5 gap-1 px-2 text-12",
        lg: "h-6 gap-1.5 px-2.5 text-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant, size }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
