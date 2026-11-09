import { apiSession, jsonError, workspaceResponse } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { isSameOrigin } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/**
 * Stops the user's own workspace so they can choose another agent ("Switch agent"; audited by the gateway with
 * reason "user"). Immediate, even while the agent is working: the page warns first. An admin viewing someone
 * else's workspace stops it from the admin console instead. A Route Handler like start: the stop includes
 * `docker stop -t 10`, and actions run one at a time per page.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
  const session = await apiSession();
  if (session instanceof Response) return session;
  if (session.actingAs) return jsonError(403, "forbidden", "You can only stop your own workspace here.");
  return workspaceResponse(gateway.stop(session.target.id, "user", session.user.id), session);
}
