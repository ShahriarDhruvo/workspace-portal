import { cn } from "@/lib/utils";
import { LoaderIcon, type IconProps } from "@/components/ui/icons";

// shadcn/ui Spinner: lucide's loader arc (three quarters of a circle, round caps) turning in currentColor, at
// the size and stroke of the icons around it (16px / 1.5; 14px inside small buttons). The open arc reads as
// motion in every frame; the CSS border ring it replaces (one solid side on a faint full track, declared 1.5px
// but drawn 1px) looked like a still "O", above all on a pending button. Under reduced motion it turns slower
// rather than stopping, so pending work still reads as pending. It announces itself as "Loading"; pass
// aria-hidden where the surrounding text already says so.

function Spinner({ className, ...props }: IconProps) {
  return (
    <LoaderIcon
      role="status"
      aria-label="Loading"
      data-slot="spinner"
      className={cn("size-4 animate-spin motion-reduce:[animation-duration:2.4s]", className)}
      {...props}
    />
  );
}

export { Spinner };
