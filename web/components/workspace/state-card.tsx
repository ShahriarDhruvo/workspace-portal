import type { ReactNode } from "react";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { WarningIcon } from "@/components/ui/icons";

interface StateCardProps {
  title: string;
  children: ReactNode;
  /** The card's buttons, the primary one last (right-aligned in the footer). */
  actions?: ReactNode;
  /** Something went wrong: the title gets the attention icon and the text is announced. */
  warning?: boolean;
}

/** Card for the workspace page's not-running states: what happened, then what to do about it. */
export function StateCard({ title, children, actions, warning = false }: StateCardProps) {
  return (
    <Card role={warning ? "alert" : "status"} className="w-[min(420px,100%)]">
      <CardHeader>
        <CardTitle>
          <h2 className="flex items-center gap-2">
            {warning ? <WarningIcon className="shrink-0 text-attention" /> : null}
            {title}
          </h2>
        </CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardHeader>
      {actions ? <CardFooter className="justify-end gap-2">{actions}</CardFooter> : null}
    </Card>
  );
}
