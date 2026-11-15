import type { ReactNode, Ref } from "react";

interface PageHeadingProps {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Makes the title a focus target (from client components): for when the control that had the focus goes away. */
  headingRef?: Ref<HTMLHeadingElement>;
}

/** A page's title (18px/600) with an optional muted line under it and actions on the right. */
export function PageHeading({ title, children, actions, headingRef }: PageHeadingProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-18 font-semibold outline-none">
          {title}
        </h1>
        {children ? <div className="text-13 text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
