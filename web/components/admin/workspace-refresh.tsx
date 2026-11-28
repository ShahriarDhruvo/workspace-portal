"use client";

import { useRouter } from "next/navigation";
import { workspaceState, type WorkspaceState } from "@/lib/format";
import type { AdminOverview } from "@/lib/overview";
import { usePoll } from "@/components/common/use-poll";

const REFRESH_MS = 5_000;

/**
 * Keeps a user's page in step with their workspace: reads the workspaces every 5 s and re-renders the page once the
 * state is no longer the one its pill shows (`shown`; null: the page couldn't read it).
 */
export function WorkspaceRefresh({ userId, shown }: { userId: number; shown: WorkspaceState | null }) {
  const router = useRouter();
  usePoll<AdminOverview>("/api/admin/overview", REFRESH_MS, (result) => {
    const workspaces = result.ok ? result.data.workspaces : null;
    const now = workspaces
      ? workspaceState(workspaces.find((workspace) => workspace.userId === userId) ?? { status: "stopped", ready: false, busy: false })
      : null;
    if (now?.label !== shown?.label || now?.activity !== shown?.activity) router.refresh();
  });
  return null;
}
