import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/session";

// The admin console: its bar (AdminNav, under the top bar) comes with the portal's layout. Pages re-check the
// admin role themselves, since layouts are not re-rendered on client navigation.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return children;
}
