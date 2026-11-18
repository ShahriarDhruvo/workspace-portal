import { jsonError, route, workspaceStatus } from "@/lib/api";
import { gateway } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/**
 * Stops the user's own workspace, at once, even while the agent is working: the pages warn first. An admin viewing
 * someone else's stops it from the admin console instead. A Route Handler like start: the stop includes
 * `docker stop -t 10`, and actions run one at a time per page.
 */
export const POST = route({}, (session) => {
  if (session.actingAs) return jsonError(403, "forbidden", "You can only stop your own workspace here.");
  return workspaceStatus(gateway.stop(session.target.id, "user", session.user.id), session);
});
