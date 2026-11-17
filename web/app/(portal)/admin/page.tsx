import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { PageMain } from "@/components/layout/page-main";
import { UsageLive } from "@/components/admin/usage/usage-live";

export const metadata: Metadata = { title: "Usage" };

/** Admin > Usage: the LLM sessions and both servers, live (the browser streams it from /api/admin/live). */
export default async function UsagePage() {
  await requireAdmin();
  return (
    <PageMain width="wide">
      <UsageLive />
    </PageMain>
  );
}
