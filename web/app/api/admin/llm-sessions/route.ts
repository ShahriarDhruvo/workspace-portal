import { apiSession, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { loadSessionPage } from "@/lib/workspace-sessions";

export const dynamic = "force-dynamic";

/**
 * Admin > Usage's sessions table: a page of the workspace sessions (?page=, from 1). Read again whenever the live
 * view says the sessions changed, and on paging.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
  return json(loadSessionPage(getDb(), Number.isSafeInteger(page) ? page : 1));
}
