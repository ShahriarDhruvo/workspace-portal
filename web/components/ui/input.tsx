import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// shadcn/ui Input as the Web Shell draws it: 32px, 6px radius, a white/15% border over a white/4.5% fill,
// placeholders in the subtle tone. Focus turns the border grey and adds a 3px ring; aria-invalid turns it red.
// The "login" variant is the auth card's 44px, 10px-radius monospace input. On touch screens: 16px text, so
// mobile browsers don't zoom in on focus, and 40px tall, for a finger.

const inputVariants = cva(
  "w-full min-w-0 border border-input bg-input/30 px-2.5 text-14 text-foreground outline-none transition-[color,border-color,box-shadow] placeholder:text-subtle-foreground pointer-coarse:text-16 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "h-8 rounded-md pointer-coarse:h-10",
        login: "h-11 rounded-xl font-mono",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Input({ className, type, variant, ...props }: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return <input type={type} data-slot="input" className={cn(inputVariants({ variant }), className)} {...props} />;
}

export { Input };
