import { apiSession, gatewayErrorResponse, json, jsonError, withTarget } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { isSameOrigin } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/**
 * Starts the session's workspace. The gateway answers as soon as the container is up (`starting`, or
 * 409 `capacity`); the workspace page then polls /api/workspace/status until it is ready. A Route
 * Handler rather than a Server Action: actions run one at a time per page, and the start can still
 * take up to 30 s when the gateway first has to evict an idle workspace.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
  const session = await apiSession();
  if (session instanceof Response) return session;
  try {
    return json(withTarget(await gateway.start(session.target.id), session));
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
