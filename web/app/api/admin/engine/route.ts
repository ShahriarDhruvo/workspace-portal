import { apiSession, json, jsonError } from "@/lib/api";
import { loadAdminEngine } from "@/lib/overview";
import { isSameOrigin } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/** The LLM engine's versions and update job for the Updates page (polled every 1 s while a job runs, else every 15 s). */
export async function GET(): Promise<Response> {
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  return json(await loadAdminEngine());
}

/**
 * "Check for updates": the same answer, after the gateway asked the image registry and GitHub again (its ?refresh=1)
 * instead of using its cached releases. A POST with the same-origin check, as on /api/admin/agents: a workspace page
 * on another port of the same site must not be able to make the server query the registry in a loop.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  return json(await loadAdminEngine({ refresh: true }));
}
