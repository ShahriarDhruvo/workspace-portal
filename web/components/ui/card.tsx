import type { ReactNode } from "react";

// Web Shell status card (transparent, 1px border at 74%, 10px radius), uppercase section labels and
// settings-style rows with 50% separators.

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-xl border border-line-soft ${className}`}>{children}</div>;
}

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 className="label-caps">{title}</h2>
        {description ? <p className="text-12 text-fg-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A settings row: label and explanation on the left, controls on the right. */
export function CardRow({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line-faint px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <div className="text-14 font-medium">{title}</div>
        {children ? <div className="text-13 text-fg-muted">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function PageHeading({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-18 font-semibold">{title}</h1>
        {children ? <div className="text-13 text-fg-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
