import { apiSession, gatewayErrorResponse, isSameOrigin, json, jsonError, withTarget } from "@/lib/api";
import { gateway } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/**
 * Starts the session's workspace and answers once it is ready (or 409 `capacity`). A Route Handler
 * rather than a Server Action: actions run one at a time per page, and this can take a minute.
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
