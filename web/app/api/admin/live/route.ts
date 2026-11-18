import { loadSessionContext } from "@portal/core";
import { jsonError, route } from "@/lib/api";
import { getDb } from "@/lib/db";
import { gateway } from "@/lib/gateway";
import { checkApiAccess } from "@/lib/request-guards";

export const dynamic = "force-dynamic";

/** An open live view re-checks the session this often: signing out or losing the admin role ends it. */
const RECHECK_MS = 30_000;

/**
 * The admin's live view (Usage): the gateway's event stream (GET /control/live, docs/ARCHITECTURE.md "Live
 * view") passed through as it is. Ends when the browser leaves, the gateway closes or drops it, or the session
 * stops being an admin's.
 */
export const GET = route({ admin: true }, async ({ session }, request) => {
  const upstream = new AbortController();
  request.signal.addEventListener("abort", () => upstream.abort(), { once: true });
  const { body } = await gateway.live(upstream.signal);
  if (body === null) return jsonError(502, "live_unavailable", "The live view is not available.");

  const recheck = setInterval(() => {
    if ("problem" in checkApiAccess(loadSessionContext(getDb(), session.id), { admin: true })) upstream.abort();
  }, RECHECK_MS);
  const stop = (): void => clearInterval(recheck);
  upstream.signal.addEventListener("abort", stop, { once: true });

  // Ends cleanly when the gateway goes away mid-stream (a restart): the browser sees a finished response and
  // reconnects, instead of a broken one (an error in its console).
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
      } catch {
        // the upstream broke: end here
      }
      stop();
      controller.close();
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
});
