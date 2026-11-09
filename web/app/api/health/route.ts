import { getDb } from "@/lib/db";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Docker healthcheck: no auth, just proves the server answers and the database opens. */
export function GET(): Response {
  try {
    getDb().$client.prepare("SELECT 1").get();
    return json({ ok: true });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return json({ ok: false }, 503);
  }
}
