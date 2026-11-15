import type { ReactNode } from "react";

/**
 * A settings row inside an outline Card: title and explanation on the left, controls on the right, rows split
 * by 50% separators. The controls wrap under the text on narrow screens.
 */
export function CardRow({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border-faint px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <div className="text-14 font-medium">{title}</div>
        {children ? <div className="text-13 text-muted-foreground">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
