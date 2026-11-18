import { route } from "@/lib/api";
import { loadAdminOverview } from "@/lib/overview";

export const dynamic = "force-dynamic";

/** Live workspace status and host stats for the admin dashboard. */
export const GET = route({ admin: true }, loadAdminOverview);
