import { route } from "@/lib/api";
import { loadAdminOverview } from "@/lib/overview";

export const dynamic = "force-dynamic";

export const GET = route({ admin: true }, loadAdminOverview);
