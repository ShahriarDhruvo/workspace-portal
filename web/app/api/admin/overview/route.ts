import { apiSession, json } from "@/lib/api";
import { loadAdminOverview } from "@/lib/overview";

export const dynamic = "force-dynamic";

/** Live workspace status and host stats for the admin dashboard (polled every 5 s). */
export async function GET(): Promise<Response> {
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  return json(await loadAdminOverview());
}
