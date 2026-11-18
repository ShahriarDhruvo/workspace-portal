import type { ReactNode } from "react";

export function PageHeading({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h1 className="mr-auto min-w-0 text-18 font-semibold">{title}</h1>
      {actions}
    </div>
  );
}
