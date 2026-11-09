// Streams one HTTP request to an upstream and its response back, without buffering or timeouts.
// Used by the agent proxy, the LLM and search-MCP proxies and the SearXNG relay.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { pipeline, Transform, type Readable, type TransformCallback } from "node:stream";
import type { HeaderMap } from "./headers.ts";

export class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export interface ForwardOptions {
  url: URL;
  method: string;
  headers: HeaderMap;
  /** Fails the request with PayloadTooLargeError once more body bytes than this have arrived. */
  bodyLimit?: number;
  responseHeaders: (upstream: IncomingMessage) => HeaderMap;
  /** Optional pass-through stream the response body flows through (e.g. a usage tap). */
  tap?: (upstream: IncomingMessage) => Transform | null;
  /** Answers the client when forwarding fails before a response was started. */
  onError: (error: Error, res: ServerResponse) => void;
}

export type ForwardOutcome = "completed" | "aborted" | "failed";

export interface ForwardResult {
  outcome: ForwardOutcome;
  /** Upstream status, or null when no upstream response arrived. */
  status: number | null;
  error: Error | null;
}

/**
 * Forwards `req` and resolves once the exchange is over. A client that goes away aborts the
 * upstream request too, which is what frees an LLM server slot when a workspace disconnects.
 */
export function forward(req: IncomingMessage, res: ServerResponse, options: ForwardOptions): Promise<ForwardResult> {
  return new Promise((resolve) => {
    let status: number | null = null;
    let settled = false;
    const settle = (outcome: ForwardOutcome, error: Error | null = null): void => {
      if (settled) return;
      settled = true;
      resolve({ outcome, status, error });
    };

    let upstream: http.ClientRequest;
    try {
      const transport = options.url.protocol === "https:" ? https : http;
      upstream = transport.request(options.url, { method: options.method, headers: options.headers, agent: false });
    } catch (error) {
      options.onError(asError(error), res);
      settle("failed", asError(error));
      return;
    }

    const fail = (error: Error): void => {
      upstream.destroy();
      if (!res.headersSent) options.onError(error, res);
      else res.destroy(error);
      settle("failed", error);
    };

    res.once("close", () => {
      if (res.writableFinished) return;
      upstream.destroy();
      settle("aborted");
    });

    upstream.once("response", (incoming) => {
      status = incoming.statusCode ?? 502;
      res.writeHead(status, options.responseHeaders(incoming));
      res.flushHeaders();
      const done = (error: Error | null): void => settle(error ? "failed" : "completed", error);
      const tap = options.tap?.(incoming) ?? null;
      if (tap) pipeline(incoming, tap, res, done);
      else pipeline(incoming, res, done);
    });
    upstream.on("error", fail);

    req.on("error", fail);
    const body: Readable = options.bodyLimit === undefined ? req : req.pipe(byteLimit(options.bodyLimit));
    if (body !== req) body.on("error", fail);
    body.pipe(upstream);
  });
}

function byteLimit(limitBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      seen += chunk.length;
      if (seen > limitBytes) callback(new PayloadTooLargeError(limitBytes));
      else callback(null, chunk);
    },
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
