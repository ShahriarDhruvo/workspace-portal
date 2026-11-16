import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

/**
 * The admin console's notice that the workspace service (the gateway) didn't answer: its message, then what that
 * means for the page (`children`, e.g. "Workspace status may be out of date.").
 */
export function ServiceIssue({ message, children }: { message: string; children: ReactNode }) {
  return (
    <Card role="alert" aria-label="Issues" className="gap-2 px-3.5 py-2.5">
      <h2 className="label-caps">Issues</h2>
      <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Badge variant="warning">Warning</Badge>
        <span>
          Workspace service unavailable: {message} {children}
        </span>
      </p>
    </Card>
  );
}
