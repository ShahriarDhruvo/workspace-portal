import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { loadEnergyMonth } from "@/lib/energy";
import { requireAdmin } from "@/lib/session";
import { EnergyView } from "@/components/admin/energy/energy-view";
import { PageMain } from "@/components/layout/page-main";

export const metadata: Metadata = { title: "Energy" };

/** Admin > Energy: both servers' energy per day and its cost, this month rendered here (the view asks for others). */
export default async function EnergyPage() {
  await requireAdmin();
  return (
    <PageMain width="lg">
      <EnergyView initial={loadEnergyMonth(getDb())} />
    </PageMain>
  );
}
