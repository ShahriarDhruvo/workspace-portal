import http from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { config } from "@/lib/config";
import { LLM_API_BODY_BYTES } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** Headers of one connection, not of the message. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);

function apiError(status: number, type: string, message: string): Response {
  return Response.json({ error: { message, type } }, { status, headers: { "access-control-allow-origin": "*" } });
}

/**
 * The LLM API for a user's own software (the API page): the portal's one address ends at this app, so every request
 * under /llm/api goes to the gateway as it came and the gateway's answer back as it comes. The gateway checks the
 * API key (gateway/src/service/llm-api.ts); no session counts here. node:http, not fetch: the answer to a long
 * prompt takes longer to start than the five minutes fetch waits.
 */
function pass(request: Request): Promise<Response> | Response {
  // next.config.ts lets a body up to this through whole; a longer one would arrive cut short.
  if (Number(request.headers.get("content-length")) > LLM_API_BODY_BYTES) return apiError(413, "request_too_large", "The request body is too large.");
  const { pathname, search } = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  delete headers.cookie;
  return new Promise((resolve) => {
    const upstream = http.request({ host: "127.0.0.1", port: config.controlPort, path: pathname + search, method: request.method, headers, agent: false });
    request.signal.addEventListener("abort", () => upstream.destroy(), { once: true });
    upstream.once("error", () => resolve(apiError(502, "api_error", "The LLM API is not reachable.")));
    upstream.once("response", (answer) => {
      const status = answer.statusCode ?? 502;
      const out = new Headers();
      for (const [name, value] of Object.entries(answer.headers)) {
        if (!HOP_BY_HOP.has(name)) for (const item of [value ?? []].flat()) out.append(name, item);
      }
      // A status without a body takes none, not even an empty stream.
      const empty = status === 204 || status === 205 || status === 304;
      if (empty) answer.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(answer) as ReadableStream<Uint8Array>), { status, headers: out }));
    });
    if (request.body) Readable.fromWeb(request.body as NodeReadableStream).pipe(upstream);
    else upstream.end();
  });
}

export { pass as GET, pass as POST, pass as PUT, pass as PATCH, pass as DELETE, pass as HEAD, pass as OPTIONS };
