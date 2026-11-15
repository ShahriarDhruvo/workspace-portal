import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { WarningIcon } from "@/components/ui/icons";

interface StateCardProps {
  title: string;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  /** Something went wrong: the title gets the attention icon. */
  warning?: boolean;
}

/** Card for the workspace's not-running states, shaped like a Web Shell alert dialog, with at most one action. */
export function StateCard({ title, children, action, warning = false }: StateCardProps) {
  return (
    <Card role="alert" className="w-[min(420px,100%)]">
      <CardHeader>
        <CardTitle asChild className="flex items-center gap-2">
          <h2>
            {warning ? <WarningIcon className="text-attention" /> : null}
            {title}
          </h2>
        </CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardHeader>
      {action ? (
        <CardFooter className="justify-end">
          <Button type="button" size="sm" className="min-w-16" onClick={action.onClick}>
            {action.label}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
