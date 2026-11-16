import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, hashSessionToken, loadSessionContext } from "@portal/db";
import { apiSession, jsonError } from "@/lib/api";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { checkApiAccess } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/** An open live view re-checks the session this often: signing out or losing the admin role ends it. */
const RECHECK_MS = 30_000;

/**
 * The admin's live view (Overview): the gateway's event stream (GET /control/live, docs/ARCHITECTURE.md "Live
 * view") passed through as it is. Ends when the browser leaves, the gateway closes it, or the session stops
 * being an admin's.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? "";
  const tokenHash = hashSessionToken(token);

  const upstream = new AbortController();
  request.signal.addEventListener("abort", () => upstream.abort(), { once: true });
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.controlPort}/control/live`, {
      headers: { authorization: `Bearer ${config.controlSecret}`, accept: "text/event-stream" },
      signal: upstream.signal,
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "unreachable", "The workspace service is not reachable.");
  }
  if (!response.ok || response.body === null) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    return jsonError(response.status, body?.error ?? "live_unavailable", body?.message ?? "The live view is not available.");
  }

  const recheck = setInterval(() => {
    if ("problem" in checkApiAccess(loadSessionContext(getDb(), tokenHash), { admin: true })) upstream.abort();
  }, RECHECK_MS);
  const stop = (): void => clearInterval(recheck);
  upstream.signal.addEventListener("abort", stop, { once: true });

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: stop,
    }),
  );
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
