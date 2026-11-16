import { apiSession, jsonError, workspaceResponse } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { isSameOrigin } from "@/lib/request-guards";
import { workspaceStartSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Starts the session's workspace of the kind the person chose and confirmed (the Start buttons; body
 * `{ kind: "private" | "online" }`, required: nothing starts without that choice). The gateway picks the agent,
 * the owner's harness from Settings, attaches to that kind if it already starts or runs, and refuses with 409
 * `kind_mismatch` while the other kind runs, 409 `online_disabled` / 403 `online_not_allowed` for an Online start
 * that may not happen, or 409 `capacity`. It answers as soon as the container is up (`starting`); the pages then
 * poll /api/workspace/status until it is ready. A Route Handler rather than a Server Action: actions run one at a
 * time per page, and the start can still take up to 30 s when the gateway first has to evict an idle workspace.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
  const session = await apiSession();
  if (session instanceof Response) return session;
  const body: unknown = await request.json().catch(() => null);
  const parsed = workspaceStartSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_kind", "Choose Private or Online.");
  return workspaceResponse(gateway.start(session.target.id, parsed.data.kind), session);
}
