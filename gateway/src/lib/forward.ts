// Streams one HTTP request to an upstream and its response back, without buffering or timeouts.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { pipeline, Transform, type Readable, type TransformCallback } from "node:stream";
import type { HeaderMap } from "../proxy/headers.ts";
import { HttpError } from "./http-util.ts";

export interface ForwardOptions {
  url: URL;
  method: string;
  headers: HeaderMap;
  /** More body bytes than this fail the request with an HttpError (413). */
  bodyLimit?: number;
  /** Sees every chunk of the request body on its way upstream. It must not throw or keep the chunk from flowing. */
  observeBody?: (chunk: Buffer) => void;
  responseHeaders: (upstream: IncomingMessage) => HeaderMap;
  /** A pass-through stream the response body flows through (a usage tap). */
  tap?: (upstream: IncomingMessage) => Transform | null;
  /** Answers the client when forwarding fails before a response was started. */
  onError: (error: Error, res: ServerResponse) => void;
}

export interface ForwardResult {
  outcome: "completed" | "aborted" | "failed";
  /** Upstream status, or null when no upstream response arrived. */
  status: number | null;
}

/** Resolves once the exchange is over. A client that goes away aborts the upstream request too, which frees its LLM server slot. */
export function forward(req: IncomingMessage, res: ServerResponse, options: ForwardOptions): Promise<ForwardResult> {
  return new Promise((resolve) => {
    let status: number | null = null;
    const settle = (outcome: ForwardResult["outcome"]): void => resolve({ outcome, status });

    let upstream: http.ClientRequest;
    try {
      upstream = (options.url.protocol === "https:" ? https : http).request(options.url, { method: options.method, headers: options.headers, agent: false });
    } catch (error) {
      options.onError(error as Error, res);
      return settle("failed");
    }

    const fail = (error: Error): void => {
      upstream.destroy();
      if (!res.headersSent) options.onError(error, res);
      else res.destroy(error);
      settle("failed");
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
      const done = (error: Error | null): void => settle(error ? "failed" : "completed");
      const tap = options.tap?.(incoming) ?? null;
      if (tap) pipeline(incoming, tap, res, done);
      else pipeline(incoming, res, done);
    });
    upstream.on("error", fail);

    req.on("error", fail);
    const body: Readable = options.bodyLimit === undefined ? req : req.pipe(byteLimit(options.bodyLimit));
    if (body !== req) body.on("error", fail);
    // Attached in the same tick as the pipe, so both see every chunk.
    if (options.observeBody) body.on("data", options.observeBody);
    body.pipe(upstream);
  });
}

function byteLimit(limitBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      seen += chunk.length;
      if (seen > limitBytes) callback(new HttpError(413, "payload_too_large", "The request body is too large."));
      else callback(null, chunk);
    },
  });
}
