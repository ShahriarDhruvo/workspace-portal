import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/session";

// The admin's pages (their tabs are in the portal's top bar, for the admin only). Pages re-check the
// admin role themselves, since layouts are not re-rendered on client navigation.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return children;
}
