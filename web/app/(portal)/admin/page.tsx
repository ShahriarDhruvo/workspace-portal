import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { loadSessionPage } from "@/lib/workspace-sessions";
import { PageMain } from "@/components/layout/page-main";
import { UsageLive } from "@/components/admin/usage/usage-live";

export const metadata: Metadata = { title: "Usage" };

/** Admin > Usage, live (the browser streams it from /api/admin/live), with the workspace sessions' first page. */
export default async function UsagePage() {
  await requireAdmin();
  return (
    <PageMain width="wide">
      <UsageLive sessions={loadSessionPage(getDb())} />
    </PageMain>
  );
}
