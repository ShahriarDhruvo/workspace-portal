import { previewPortFor } from "@portal/core";
import { route, type WorkspaceServersResponse } from "@/lib/api";
import { config } from "@/lib/config";
import { gateway } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/** The web servers running in the workspace this session uses (its target's), and the preview port that shows them. */
export const GET = route({}, async (session): Promise<WorkspaceServersResponse> => {
  const { workspace, servers } = await gateway.servers(session.target.id);
  const previewPort = workspace ? previewPortFor(config.agentPortBase, config.agentPortCount, session.target.id, workspace) : null;
  return { previewPort, servers: previewPort === null ? [] : servers };
});
