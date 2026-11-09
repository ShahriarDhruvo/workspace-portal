// Small HTTP helpers shared by the gateway's servers.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

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

/** The error shape of every gateway API: `{ error: <code>, message: <human text> }`. */
export function sendError(res: ServerResponse, status: number, code: string, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { error: code, message }, headers);
}

/** Reads a small JSON body; undefined when empty. */
export async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, "payload_too_large", "The request body is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

/**
 * A browser loading a page (top level or in a frame), as opposed to fetch/XHR, assets or
 * WebSockets: `Sec-Fetch-Mode: navigate`, or `Accept: text/html` from browsers without Fetch Metadata.
 */
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
