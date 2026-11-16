import type { WorkspaceKind } from "@portal/db";
import { KIND_NAMES } from "@/lib/workspace-kind";
import { Badge } from "@/components/ui/badge";
import { GlobeIcon, LockIcon } from "@/components/ui/icons";

/**
 * Which of the user's two workspaces runs: Private (a lock) or Online (a globe), as a small outline pill. Shown
 * wherever a running workspace is: Home's card, the workspace bar, a user's page and the admin tables. `compact`
 * (the workspace bar): only the icon on phones, the name kept for screen readers.
 */
export function KindBadge({ kind, compact = false }: { kind: WorkspaceKind; compact?: boolean }) {
  const Icon = kind === "online" ? GlobeIcon : LockIcon;
  return (
    <Badge variant="outline" title={compact ? KIND_NAMES[kind] : undefined}>
      <Icon />
      <span className={compact ? "max-sm:sr-only" : undefined}>{KIND_NAMES[kind]}</span>
      <span className="sr-only"> workspace</span>
    </Badge>
  );
}
