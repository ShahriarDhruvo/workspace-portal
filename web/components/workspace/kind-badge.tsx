import { WORKSPACE_KIND_NAMES, type WorkspaceKind } from "@portal/core/wire";
import { Badge } from "@/components/ui/badge";
import { GlobeIcon, LockIcon } from "@/components/ui/icons";

/**
 * Which of the user's two workspaces runs. `compact` (the workspace bar): only the icon on phones, the name kept for
 * screen readers.
 */
export function KindBadge({ kind, compact = false }: { kind: WorkspaceKind; compact?: boolean }) {
  const Icon = kind === "online" ? GlobeIcon : LockIcon;
  return (
    <Badge variant="outline" title={compact ? WORKSPACE_KIND_NAMES[kind] : undefined}>
      <Icon />
      <span className={compact ? "max-sm:sr-only" : undefined}>{WORKSPACE_KIND_NAMES[kind]}</span>
      <span className="sr-only"> workspace</span>
    </Badge>
  );
}
