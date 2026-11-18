import { jsonError, route, workspaceStatus } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { workspaceStartSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Starts the session's workspace of the kind the person chose and confirmed (body `{ kind }`, required). It answers
 * as soon as the container is up (`starting`); the pages then poll /api/workspace/status until it is ready. A Route
 * Handler rather than a Server Action: actions run one at a time per page, and the start can take up to 30 s when the
 * gateway first has to evict an idle workspace.
 */
export const POST = route({}, async (session, request) => {
  const parsed = workspaceStartSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_kind", "Choose Private or Online.");
  return workspaceStatus(gateway.start(session.target.id, parsed.data.kind), session);
});
