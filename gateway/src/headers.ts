// Pure header rewriting for the proxies: hop-by-hop removal, the Qwen Code request/response recipe
// (Host, Origin, cookies, credentials, framing), Origin validation, and the service API's LLM
// requests.
import type { IncomingHttpHeaders } from "node:http";

export type HeaderMap = Record<string, string | string[]>;

/** RFC 9110 §7.6.1 connection-specific fields, plus the legacy ones proxies still see. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Copies headers without hop-by-hop fields, including any the Connection header names. */
export function endToEndHeaders(headers: IncomingHttpHeaders): HeaderMap {
  const drop = new Set(HOP_BY_HOP);
  for (const token of String(headers.connection ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) drop.add(name);
  }
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !drop.has(name)) out[name] = value;
  }
  return out;
}

// ------------------------------------------------------------------ browser checks

export interface HostParts {
  /** Lowercase host name, or a bracketed IPv6 literal. */
  hostname: string;
  port: number | null;
}

/** Parses a Host header (`name[:port]` or `[v6]:port`); null if it is missing or malformed. */
export function parseHostHeader(value: string | undefined): HostParts | null {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(value ?? "");
  if (!match) return null;
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { hostname: match[1]!.toLowerCase(), port };
}

/** True when Origin names exactly the host and port the browser used to reach the gateway. */
export function originMatchesHost(origin: string, host: HostParts): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const originPort = url.port === "" ? defaultPort : Number(url.port);
  return url.hostname.toLowerCase() === host.hostname && originPort === (host.port ?? defaultPort);
}

/** Cross-site requests may only read (GET/HEAD); they may never change state or open the agent socket. */
export function rejectsCrossSite(method: string, headers: IncomingHttpHeaders, upgrade: boolean): boolean {
  if (headers["sec-fetch-site"] !== "cross-site") return false;
  return upgrade || (method !== "GET" && method !== "HEAD");
}

// ------------------------------------------------------------------ Qwen Code recipe

/** Browser-supplied fields never passed to a workspace. `expect` is answered by the gateway itself. */
const STRIPPED_REQUEST = new Set([
  "host",
  "cookie",
  "origin",
  "authorization",
  "expect",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

/** WebSocket subprotocol prefix the Web Shell uses to carry its bearer token (browsers can't set headers). */
export const BEARER_SUBPROTOCOL_PREFIX = "qwen-bearer.";

/**
 * Headers for a request forwarded to a workspace's `qwen serve`. No cookie (the portal session stays
 * with the gateway), no Origin (the gateway checked it), and the container's own token as the only
 * credential, set only when the browser presented its valid workspace token.
 */
export function qwenRequestHeaders(
  incoming: IncomingHttpHeaders,
  authority: string,
  serverToken: string | null,
  options: { websocket?: boolean } = {},
): HeaderMap {
  const out = endToEndHeaders(incoming);
  for (const name of Object.keys(out)) {
    if (STRIPPED_REQUEST.has(name) || name.startsWith("sec-fetch-") || (options.websocket && name.startsWith("sec-websocket-"))) {
      delete out[name];
    }
  }
  out.host = authority;
  if (serverToken !== null) out.authorization = `Bearer ${serverToken}`;
  return out;
}

/** The bearer token of an Authorization header, or null when there is none (or another scheme). */
export function bearerToken(header: string | undefined): string | null {
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1]! : null;
}

/**
 * Splits a Sec-WebSocket-Protocol offer into the Web Shell's bearer token (decoded) and the other
 * protocols, which are passed on unchanged.
 */
export function splitBearerSubprotocol(header: string | undefined): { token: string | null; protocols: string[] } {
  let token: string | null = null;
  const protocols: string[] = [];
  for (const raw of (header ?? "").split(",")) {
    const protocol = raw.trim();
    if (protocol === "") continue;
    if (protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX)) {
      const encoded = protocol.slice(BEARER_SUBPROTOCOL_PREFIX.length);
      token = /^[A-Za-z0-9_-]+={0,2}$/.test(encoded) ? Buffer.from(encoded, "base64url").toString("utf8") : "";
    } else {
      protocols.push(protocol);
    }
  }
  return { token, protocols };
}

/** Who may frame a workspace: the portal page, i.e. the same host on the portal's port. */
export interface FramePolicy {
  hostname: string;
  webPort: number;
}

/** The pages allowed to frame the agent: only the portal (WEB_PORT on the same host). */
export function frameAncestorSources({ hostname, webPort }: FramePolicy): string {
  return `http://${hostname}:${webPort} https://${hostname}:${webPort}`;
}

/**
 * Sets frame-ancestors in a Content-Security-Policy value (one header or a comma-separated
 * policy list), replacing any existing frame-ancestors directive and keeping all others.
 */
export function mergeFrameAncestors(existing: string | string[] | undefined, sources: string): string {
  const directive = `frame-ancestors ${sources}`;
  const values = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  const policies = values
    .flatMap((value) => value.split(","))
    .map((policy) =>
      policy
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part !== "" && !/^frame-ancestors(?:\s|$)/i.test(part)),
    )
    .filter((parts) => parts.length > 0);
  if (policies.length === 0) return directive;
  return policies.map((parts) => [...parts, directive].join("; ")).join(", ");
}

/**
 * Workspace responses are personal, so nothing may linger in shared caches. The workspace's own
 * policy is kept only when it already forces revalidation (`no-cache`/`no-store`) or marks a
 * content-addressed asset `immutable`; anything else is not stored.
 */
export function workspaceCacheControl(upstream: string | string[] | undefined): string {
  const value = Array.isArray(upstream) ? upstream.join(", ") : upstream;
  if (value && /(?:^|[,\s])(?:no-store|no-cache|immutable)(?:$|[,\s=])/i.test(value)) return value;
  return "private, no-store";
}

/** Workspace response headers as the browser gets them: no cookies, framing allowed for the portal only. */
export function qwenResponseHeaders(upstream: IncomingHttpHeaders, frame: FramePolicy, status?: number): HeaderMap {
  const out = endToEndHeaders(upstream);
  delete out["set-cookie"];
  delete out["x-frame-options"];
  // A 304 only refreshes a response the browser already holds under the workspace's own policy.
  if (status !== 304) {
    delete out.expires;
    out["cache-control"] = workspaceCacheControl(upstream["cache-control"]);
  }
  out["content-security-policy"] = mergeFrameAncestors(upstream["content-security-policy"], frameAncestorSources(frame));
  return out;
}

// ------------------------------------------------------------------ service API

/**
 * Headers for a request to the LLM server: the workspace's placeholder key is replaced by the real
 * one (or dropped), and responses are requested uncompressed so usage can be read from them.
 */
export function llmRequestHeaders(incoming: IncomingHttpHeaders, apiKey: string): HeaderMap {
  const out = endToEndHeaders(incoming);
  delete out.host;
  delete out.expect;
  delete out.authorization;
  out["accept-encoding"] = "identity";
  if (apiKey) out.authorization = `Bearer ${apiKey}`;
  return out;
}
