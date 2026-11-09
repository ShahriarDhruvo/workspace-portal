import { apiSession, workspaceResponse } from "@/lib/api";
import { gateway } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/** The workspace this session uses (its target), as the gateway reports it. Polled by the workspace page. */
export async function GET(): Promise<Response> {
  const session = await apiSession();
  if (session instanceof Response) return session;
  return workspaceResponse(gateway.getWorkspace(session.target.id), session);
}
