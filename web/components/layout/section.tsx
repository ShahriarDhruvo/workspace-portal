import type { ReactNode } from "react";

/** A titled block of a settings page: an uppercase muted label, an optional description, then its content. */
export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 className="label-caps">{title}</h2>
        {description ? <p className="text-12 text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
