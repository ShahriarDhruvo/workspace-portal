import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { readBounded, type ApiError } from "@portal/core";
import type { Logger } from "./log.ts";

/**
 * A server for open-ended exchanges (uploads, event streams, LLM generations): no request timeout. Node derives the
 * headers timeout from it, so with none it would wait forever for headers too (slowloris): that one is set.
 * A handler that fails answers 500, logged as "<what> request failed".
 */
export function createStreamingServer(log: Logger, what: string, handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>): http.Server {
  return http.createServer({ requestTimeout: 0, headersTimeout: 60_000 }, (req, res) => {
    handle(req, res).catch((error: unknown) => {
      log.error(`${what} request failed`, { error });
      if (!res.headersSent) sendError(res, 500, "internal", "Internal error.");
      else res.destroy();
    });
  });
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { error: code, message } satisfies ApiError, headers);
}

/** Reads a small JSON body; undefined when empty. */
export async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const body = await readBounded(req, limitBytes);
  if (body === null) throw new HttpError(413, "payload_too_large", "The request body is too large.");
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

/** A browser loading a page (top level or in a frame): `Sec-Fetch-Mode: navigate`, or `Accept: text/html` without Fetch Metadata. */
export function isDocumentNavigation(method: string, headers: IncomingHttpHeaders): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const mode = headers["sec-fetch-mode"];
  if (mode !== undefined) return mode === "navigate";
  return (headers.accept ?? "").includes("text/html");
}

/** The peer's address, with IPv4-mapped IPv6 addresses written as plain IPv4. */
export function remoteAddress(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** Splits an origin-form request target into path and query (`?…`, or ""). */
export function splitTarget(target: string): { pathname: string; search: string } {
  const index = target.indexOf("?");
  return index === -1 ? { pathname: target, search: "" } : { pathname: target.slice(0, index), search: target.slice(index) };
}
