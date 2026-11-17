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

/**
 * Same-site requests come from another port of this host: the portal, or another workspace's origin (the user's
 * Online one included). SameSite=Lax only holds between sites, so the browser sends the portal's session cookie
 * along with them, an image or script a page there merely asks for included. All they may do is what the portal
 * itself does: navigate its iframe (GET or HEAD), and for a preview port (`pages`) also open it in a tab of its own
 * (the Web preview's "Open externally"). Anything else, WebSockets included, is refused.
 */
export function rejectsSameSite(method: string, headers: IncomingHttpHeaders, upgrade: boolean, pages = false): boolean {
  if (headers["sec-fetch-site"] !== "same-site") return false;
  const dest = headers["sec-fetch-dest"];
  const navigation = headers["sec-fetch-mode"] === "navigate" && (dest === "iframe" || (pages && dest === "document"));
  return upgrade || !navigation || (method !== "GET" && method !== "HEAD");
}

// ------------------------------------------------------------------ workspace requests and responses

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

/** WebSocket subprotocol prefix a token agent's UI uses to carry its bearer token (browsers can't set headers). */
export const BEARER_SUBPROTOCOL_PREFIX = "qwen-bearer.";

/**
 * The browser's request headers as a workspace may see them, with Host set to `authority`: no
 * cookie (the portal session stays with the gateway), no Origin (the gateway checked it), no
 * credentials and no forwarding headers. The agent's driver adds its own credential.
 */
export function workspaceRequestHeaders(incoming: IncomingHttpHeaders, authority: string, options: { websocket?: boolean } = {}): HeaderMap {
  const out = endToEndHeaders(incoming);
  for (const name of Object.keys(out)) {
    if (STRIPPED_REQUEST.has(name) || name.startsWith("sec-fetch-") || (options.websocket && name.startsWith("sec-websocket-"))) {
      delete out[name];
    }
  }
  out.host = authority;
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

/**
 * Who may frame a workspace: the portal page, i.e. the same host on the portal's port; for a preview port also the
 * workspace's agent port (the Web Shell's Web preview frames the app, inside the portal's frame).
 */
export interface FramePolicy {
  hostname: string;
  webPort: number;
  agentPort?: number;
}

/** The pages allowed to frame the agent: only the portal (WEB_PORT on the same host); a preview also the agent. */
export function frameAncestorSources({ hostname, webPort, agentPort }: FramePolicy): string {
  const ports = agentPort === undefined ? [webPort] : [webPort, agentPort];
  return ports.map((port) => `http://${hostname}:${port} https://${hostname}:${port}`).join(" ");
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
export function workspaceResponseHeaders(upstream: IncomingHttpHeaders, frame: FramePolicy, status?: number): HeaderMap {
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

// ------------------------------------------------------------------ previews

/** The cookies the portal and gateway set start with this; a workspace's app neither sees nor sets them. */
const PORTAL_COOKIE_PREFIX = "portal_";

/** A cookie (a Cookie pair, or a Set-Cookie value) of the portal's own. */
export function isPortalCookie(cookie: string): boolean {
  return cookie.trimStart().toLowerCase().startsWith(PORTAL_COOKIE_PREFIX);
}

/** A Cookie header without the portal's own cookies (the session first of all); null when nothing is left. */
export function withoutPortalCookies(cookie: string | undefined): string | null {
  const kept = (cookie ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !isPortalCookie(pair));
  return kept.length > 0 ? kept.join("; ") : null;
}

/** A preview's request target as given: a dev server answers `localhost:<port>` (Vite and Next check Host and Origin). */
export function localAuthority(port: number): string {
  return `localhost:${port}`;
}

/**
 * The browser's request headers as a workspace's web app may see them: as if the browser were on the workspace
 * itself (Host, Origin and the Referer's origin say localhost:<port>), its own cookies but none of the portal's,
 * and no forwarding headers. The browser's origin is `origin` (the preview port's).
 */
export function previewRequestHeaders(incoming: IncomingHttpHeaders, origin: string, port: number): HeaderMap {
  const out = endToEndHeaders(incoming);
  for (const name of ["host", "cookie", "expect", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-real-ip"]) {
    delete out[name];
  }
  const local = `http://${localAuthority(port)}`;
  out.host = localAuthority(port);
  if (incoming.origin !== undefined) out.origin = local;
  const { referer } = incoming;
  if (referer !== undefined) {
    if (referer === origin || referer.startsWith(`${origin}/`)) out.referer = local + referer.slice(origin.length);
    else delete out.referer;
  }
  const cookie = withoutPortalCookies(incoming.cookie);
  if (cookie !== null) out.cookie = cookie;
  return out;
}

/**
 * A Private workspace's app may load, send and fetch only from its own preview origin (and data: and blob:): what
 * runs in the person's browser can't take the workspace's data off to the internet, which the workspace itself
 * can't reach. Inside the Web preview its frame can't be navigated anywhere else either (the preview's frame-src).
 */
export function privatePreviewPolicy(origin: string): string {
  const socket = origin.replace(/^http/, "ws");
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline' data: blob:",
    `connect-src 'self' ${socket}`,
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");
}

/** A redirect to the app's own address (`http://localhost:<port>/x`, also 127.0.0.1 and 0.0.0.0) becomes `/x`. */
export function previewLocation(location: string, port: number): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location; // relative: already right
  }
  const local = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname) && (url.port === "" ? 80 : Number(url.port)) === port;
  return url.protocol === "http:" && local ? `${url.pathname}${url.search}${url.hash}` : location;
}

/**
 * A workspace app's response as the browser gets it: framed only by its workspace's Web Shell inside the portal,
 * never setting a portal cookie, not kept in shared caches (as the agent's), its own redirects kept on the preview
 * origin, and for a Private workspace confined to that origin (privatePreviewPolicy).
 */
export function previewResponseHeaders(
  upstream: IncomingHttpHeaders,
  options: { frame: FramePolicy; port: number; privateOrigin: string | null },
  status?: number,
): HeaderMap {
  const out = endToEndHeaders(upstream);
  delete out["x-frame-options"];
  const cookies = (upstream["set-cookie"] ?? []).filter((cookie) => !isPortalCookie(cookie));
  if (cookies.length > 0) out["set-cookie"] = cookies;
  else delete out["set-cookie"];
  if (typeof upstream.location === "string") out.location = previewLocation(upstream.location, options.port);
  if (status !== 304) {
    delete out.expires;
    out["cache-control"] = workspaceCacheControl(upstream["cache-control"]);
  }
  const own = upstream["content-security-policy"];
  const policies = [...(own === undefined ? [] : Array.isArray(own) ? own : [own]), ...(options.privateOrigin ? [privatePreviewPolicy(options.privateOrigin)] : [])];
  out["content-security-policy"] = mergeFrameAncestors(policies, frameAncestorSources(options.frame));
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
