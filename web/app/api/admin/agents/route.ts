import { apiSession, json, jsonError } from "@/lib/api";
import { loadAdminAgents } from "@/lib/overview";
import { isSameOrigin } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/** The agents' versions and the update job for the Agents page (polled every 2 s while a job runs, else every 30 s). */
export async function GET(): Promise<Response> {
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  return json(await loadAdminAgents());
}

/**
 * "Check for updates": the same answer, after the gateway asked the npm registry again instead of using its cached
 * release channels. A POST with the same-origin check of the state-changing routes: a workspace page the admin has
 * open (another port, so another origin, but the same site, so it gets the session cookie) must not be able to make
 * the server query npm in a loop. A GET couldn't be checked: browsers send no Origin with a same-origin GET.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  return json(await loadAdminAgents({ refresh: true }));
}
