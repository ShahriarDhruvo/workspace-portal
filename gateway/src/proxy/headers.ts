// Pure header rewriting for the proxies: hop-by-hop removal, the browser checks (Host, Origin, Fetch Metadata), what
// an agent and a workspace's web app see of a browser's request and the browser of their answers, and the LLM proxy's
// requests.
import type { IncomingHttpHeaders } from "node:http";

export type HeaderMap = Record<string, string | string[]>;

/** RFC 9110 §7.6.1 connection-specific fields, plus the legacy ones proxies still see. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

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
 * Same-site requests come from another port of this host: the portal, or another workspace's origin (the user's own
 * Online one included). SameSite=Lax only holds between sites, so the browser sends the portal's session cookie along
 * with them, an image or script a page there merely asks for included. All they may do is what the portal itself
 * does: navigate its iframe (GET or HEAD), and for a preview port (`pages`) also open it in a tab of its own.
 * Anything else, WebSockets included, is refused.
 */
export function rejectsSameSite(method: string, headers: IncomingHttpHeaders, upgrade: boolean, pages: boolean): boolean {
  if (headers["sec-fetch-site"] !== "same-site") return false;
  const dest = headers["sec-fetch-dest"];
  const navigation = headers["sec-fetch-mode"] === "navigate" && (dest === "iframe" || (pages && dest === "document"));
  return upgrade || !navigation || (method !== "GET" && method !== "HEAD");
}

/** Never passed into a workspace: the portal's cookies, where the browser really is, and `expect` (the gateway answers it). */
const notForwarded = (name: string): boolean => ["host", "cookie", "expect", "forwarded", "x-real-ip"].includes(name) || name.startsWith("x-forwarded-");

/** WebSocket subprotocol prefix a token agent's UI uses to carry its bearer token (browsers can't set headers). */
export const BEARER_SUBPROTOCOL_PREFIX = "qwen-bearer.";

/**
 * The browser's request headers as an agent may see them, with Host set to `authority`: also no Origin (the gateway
 * checked it) and no credentials (the agent's driver adds its own).
 */
export function workspaceRequestHeaders(incoming: IncomingHttpHeaders, authority: string, options: { websocket?: boolean } = {}): HeaderMap {
  const out = endToEndHeaders(incoming);
  for (const name of Object.keys(out)) {
    const stripped = notForwarded(name) || name === "origin" || name === "authorization" || name.startsWith("sec-fetch-");
    if (stripped || (options.websocket && name.startsWith("sec-websocket-"))) delete out[name];
  }
  out.host = authority;
  return out;
}

/** The bearer token of an Authorization header, or null when there is none (or another scheme). */
export function bearerToken(header: string | undefined): string | null {
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1]! : null;
}

/** Splits a Sec-WebSocket-Protocol offer into the Web Shell's bearer token (decoded) and the other protocols. */
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
 * Who may frame a workspace, as origins: the portal page; a preview port also its workspace's agent port (the Web
 * Shell's Web preview frames the app, inside the portal's frame).
 */
export interface FramePolicy {
  portal: string;
  agent?: string;
}

export const frameAncestorSources = ({ portal, agent }: FramePolicy): string => (agent ? `${portal} ${agent}` : portal);

/**
 * Sets frame-ancestors in a Content-Security-Policy value (one header or a comma-separated policy list), replacing
 * any existing frame-ancestors directive and keeping all others.
 */
export function mergeFrameAncestors(existing: string | string[] | undefined, sources: string): string {
  const directive = `frame-ancestors ${sources}`;
  const policies = [existing ?? []]
    .flat()
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
 * Workspace responses are personal, so nothing may linger in shared caches. The workspace's own policy is kept only
 * when it already forces revalidation (`no-cache`/`no-store`) or marks a content-addressed asset `immutable`.
 */
export function workspaceCacheControl(upstream: string | string[] | undefined): string {
  const value = Array.isArray(upstream) ? upstream.join(", ") : upstream;
  if (value && /(?:^|[,\s])(?:no-store|no-cache|immutable)(?:$|[,\s=])/i.test(value)) return value;
  return "private, no-store";
}

/** What every answer from a workspace gets: framing by `frame` only (after `policies`), and the cache rule above. */
function responseHeaders(upstream: IncomingHttpHeaders, frame: FramePolicy, status: number | undefined, policies: string | string[] | undefined): HeaderMap {
  const out = endToEndHeaders(upstream);
  delete out["x-frame-options"];
  // A 304 only refreshes a response the browser already holds under the workspace's own policy.
  if (status !== 304) {
    delete out.expires;
    out["cache-control"] = workspaceCacheControl(upstream["cache-control"]);
  }
  out["content-security-policy"] = mergeFrameAncestors(policies, frameAncestorSources(frame));
  return out;
}

/** An agent's response headers as the browser gets them: no cookies, framing allowed for the portal only. */
export function workspaceResponseHeaders(upstream: IncomingHttpHeaders, frame: FramePolicy, status?: number): HeaderMap {
  const out = responseHeaders(upstream, frame, status, upstream["content-security-policy"]);
  delete out["set-cookie"];
  return out;
}

/** The cookies the portal and gateway set start with `portal_`; a workspace's app neither sees nor sets them. */
export function isPortalCookie(cookie: string): boolean {
  return cookie.trimStart().toLowerCase().startsWith("portal_");
}

/**
 * The browser's request headers as a workspace's web app may see them: as if the browser were on the workspace itself
 * (Host, Origin and the Referer's origin say localhost:<port>, which dev servers such as Vite and Next check), its own
 * cookies but none of the portal's. The browser's origin is `origin` (the preview port's).
 */
export function previewRequestHeaders(incoming: IncomingHttpHeaders, origin: string, port: number): HeaderMap {
  const out = endToEndHeaders(incoming);
  for (const name of Object.keys(out)) if (notForwarded(name)) delete out[name];
  out.host = `localhost:${port}`;
  const local = `http://${out.host}`;
  if (incoming.origin !== undefined) out.origin = local;
  const { referer } = incoming;
  if (referer !== undefined) {
    if (referer === origin || referer.startsWith(`${origin}/`)) out.referer = local + referer.slice(origin.length);
    else delete out.referer;
  }
  const cookies = (incoming.cookie ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !isPortalCookie(pair));
  if (cookies.length > 0) out.cookie = cookies.join("; ");
  return out;
}

/**
 * A Private workspace's app may load, send and fetch only from its own preview origin (and data: and blob:): what
 * runs in the person's browser can't take the workspace's data off to the internet, which the workspace itself
 * can't reach.
 */
function privatePreviewPolicy(origin: string): string {
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline' data: blob:",
    `connect-src 'self' ${origin.replace(/^http/, "ws")}`,
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");
}

/** A redirect to the app's own address (`http://localhost:<port>/x`, also 127.0.0.1, 0.0.0.0 and [::1]) becomes `/x`. */
function previewLocation(location: string, port: number): string {
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
 * never setting a portal cookie, its own redirects kept on the preview origin, and for a Private workspace confined
 * to that origin (privatePreviewPolicy).
 */
export function previewResponseHeaders(
  upstream: IncomingHttpHeaders,
  options: { frame: FramePolicy; port: number; privateOrigin: string | null },
  status?: number,
): HeaderMap {
  const policies = [upstream["content-security-policy"] ?? [], options.privateOrigin ? privatePreviewPolicy(options.privateOrigin) : []].flat();
  const out = responseHeaders(upstream, options.frame, status, policies);
  const cookies = (upstream["set-cookie"] ?? []).filter((cookie) => !isPortalCookie(cookie));
  if (cookies.length > 0) out["set-cookie"] = cookies;
  else delete out["set-cookie"];
  if (typeof upstream.location === "string") out.location = previewLocation(upstream.location, options.port);
  return out;
}

/**
 * Headers for a request to the LLM server: the workspace's placeholder key is replaced by the real one (or dropped),
 * and responses are requested uncompressed so usage can be read from them.
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
