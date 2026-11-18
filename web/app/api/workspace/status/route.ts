import { route, workspaceStatus } from "@/lib/api";
import { gateway } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/** The workspace this session uses (its target), as the gateway reports it. */
export const GET = route({}, (session) => workspaceStatus(gateway.getWorkspace(session.target.id), session));
