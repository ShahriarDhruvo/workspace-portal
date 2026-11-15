import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

// shadcn/ui Card. "default" is the solid #171717 panel with a 1px border (state cards, the agent chooser, the
// auth card); "outline" the Web Shell's transparent status card with its border at 74% (settings sections,
// stat tiles, forms). 10px radius, no shadow (shadows barely show on near-black), 16px padding.

const cardVariants = cva("flex min-w-0 flex-col gap-4 rounded-xl border py-4 text-card-foreground", {
  variants: {
    variant: {
      default: "bg-card",
      outline: "border-border-soft",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Card({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" className={cn(cardVariants({ variant }), className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The card's title; `asChild` makes it a heading of the right level (e.g. `<CardTitle asChild><h2>`). Classes go on
 * CardTitle, where cn() resolves them against its own; Slot would only append the heading's (text-24 beside text-16).
 */
function CardTitle({ className, asChild = false, ...props }: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp data-slot="card-title" className={cn("text-16 leading-snug font-medium", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-14 text-muted-foreground", className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-4", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center px-4", className)} {...props} />;
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
