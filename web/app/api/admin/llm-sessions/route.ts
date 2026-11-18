import { route } from "@/lib/api";
import { getDb } from "@/lib/db";
import { loadSessionPage } from "@/lib/workspace-sessions";

export const dynamic = "force-dynamic";

/** Admin > Usage's sessions table: a page of the workspace sessions (?page=, from 1). */
export const GET = route({ admin: true }, (_session, request) => {
  const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
  return loadSessionPage(getDb(), Number.isSafeInteger(page) ? page : 1);
});
