import { apiSession, jsonError, workspaceResponse } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { isSameOrigin, parseStartRequest } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/**
 * Starts the session's workspace with the agent in the body, `{agent}` (the page always names one). The gateway
 * answers as soon as the container is up (`starting`), or with 409 `capacity`, or 409 `agent_mismatch` when
 * the workspace already runs another agent; the workspace page then polls /api/workspace/status until it is
 * ready. A Route Handler rather than a Server Action: actions run one at a time per page, and the start can
 * still take up to 30 s when the gateway first has to evict an idle workspace.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
  const session = await apiSession();
  if (session instanceof Response) return session;
  const body = parseStartRequest(await request.text());
  if ("problem" in body) return jsonError(400, body.problem.error, body.problem.message);
  return workspaceResponse(gateway.start(session.target.id, body.request), session);
}
