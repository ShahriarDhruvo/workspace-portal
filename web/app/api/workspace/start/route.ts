import { apiSession, jsonError, workspaceResponse } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { isSameOrigin } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/**
 * Starts the session's workspace (the Start buttons; no body). The gateway picks the agent, the owner's harness
 * from Settings, and attaches to whatever already starts or runs. It answers as soon as the container is up
 * (`starting`), or with 409 `capacity`; the pages then poll /api/workspace/status until it is ready. A Route
 * Handler rather than a Server Action: actions run one at a time per page, and the start can still take up to
 * 30 s when the gateway first has to evict an idle workspace.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
  const session = await apiSession();
  if (session instanceof Response) return session;
  return workspaceResponse(gateway.start(session.target.id), session);
}
