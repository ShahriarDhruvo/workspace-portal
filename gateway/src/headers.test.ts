import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEARER_SUBPROTOCOL_PREFIX,
  bearerToken,
  endToEndHeaders,
  frameAncestorSources,
  llmRequestHeaders,
  mergeFrameAncestors,
  originMatchesHost,
  parseHostHeader,
  qwenRequestHeaders,
  qwenResponseHeaders,
  rejectsCrossSite,
  splitBearerSubprotocol,
  workspaceCacheControl,
} from "./headers.ts";

const subprotocol = (token: string): string => `${BEARER_SUBPROTOCOL_PREFIX}${Buffer.from(token).toString("base64url")}`;

test("endToEndHeaders drops hop-by-hop fields and those named in Connection", () => {
  const out = endToEndHeaders({
    connection: "keep-alive, X-Secret-Hop",
    "keep-alive": "timeout=5",
    "proxy-authorization": "Basic x",
    te: "trailers",
    trailer: "x",
    "transfer-encoding": "chunked",
    upgrade: "websocket",
    "x-secret-hop": "1",
    "content-type": "text/plain",
    accept: "*/*",
  });
  assert.deepEqual(out, { "content-type": "text/plain", accept: "*/*" });
});

test("parseHostHeader", () => {
  assert.deepEqual(parseHostHeader("192.0.2.10:3001"), { hostname: "192.0.2.10", port: 3001 });
  assert.deepEqual(parseHostHeader("Portal.Example.com"), { hostname: "portal.example.com", port: null });
  assert.deepEqual(parseHostHeader("[::1]:3001"), { hostname: "[::1]", port: 3001 });
  for (const bad of [undefined, "", "a b", "host:abc", "host:0", "host:70000", "evil.com/x", "a@b", "host:3001:1"]) {
    assert.equal(parseHostHeader(bad), null, String(bad));
  }
});

test("originMatchesHost compares host and effective port", () => {
  const host = parseHostHeader("192.0.2.10:3001")!;
  assert.equal(originMatchesHost("http://192.0.2.10:3001", host), true);
  assert.equal(originMatchesHost("https://192.0.2.10:3001", host), true);
  assert.equal(originMatchesHost("http://192.0.2.10:3000", host), false, "the portal's own port is another origin");
  assert.equal(originMatchesHost("http://192.0.2.11:3001", host), false);
  assert.equal(originMatchesHost("null", host), false);
  assert.equal(originMatchesHost("file:///etc", host), false);
  assert.equal(originMatchesHost("not a url", host), false);

  const named = parseHostHeader("Portal.example.com")!;
  assert.equal(originMatchesHost("http://portal.EXAMPLE.com", named), true);
  assert.equal(originMatchesHost("http://portal.example.com:80", named), true);
  assert.equal(originMatchesHost("https://portal.example.com", named), true, "behind a TLS proxy the Host has no port");
  assert.equal(originMatchesHost("http://portal.example.com:443", named), false, "a port-less Host means the scheme's default");
  assert.equal(originMatchesHost("https://portal.example.com", parseHostHeader("portal.example.com:443")!), true);
  assert.equal(originMatchesHost("https://portal.example.com", parseHostHeader("portal.example.com:3001")!), false);
});

test("rejectsCrossSite blocks cross-site writes and WebSockets only", () => {
  const cross = { "sec-fetch-site": "cross-site" };
  assert.equal(rejectsCrossSite("GET", cross, false), false);
  assert.equal(rejectsCrossSite("HEAD", cross, false), false);
  assert.equal(rejectsCrossSite("POST", cross, false), true);
  assert.equal(rejectsCrossSite("DELETE", cross, false), true);
  assert.equal(rejectsCrossSite("GET", cross, true), true);
  assert.equal(rejectsCrossSite("POST", { "sec-fetch-site": "same-site" }, false), false);
  assert.equal(rejectsCrossSite("POST", {}, true), false);
});

test("mergeFrameAncestors", () => {
  const sources = "http://h:* https://h:*";
  assert.equal(mergeFrameAncestors(undefined, sources), `frame-ancestors ${sources}`);
  assert.equal(mergeFrameAncestors("", sources), `frame-ancestors ${sources}`);
  assert.equal(
    mergeFrameAncestors("default-src 'self'; img-src * data:", sources),
    `default-src 'self'; img-src * data:; frame-ancestors ${sources}`,
  );
  assert.equal(
    mergeFrameAncestors("default-src 'self'; Frame-Ancestors 'none' ; script-src 'self';", sources),
    `default-src 'self'; script-src 'self'; frame-ancestors ${sources}`,
  );
  assert.equal(mergeFrameAncestors("frame-ancestors 'self'", sources), `frame-ancestors ${sources}`);
  assert.equal(
    mergeFrameAncestors(["default-src 'self'", "script-src 'none'; frame-ancestors 'none'"], sources),
    `default-src 'self'; frame-ancestors ${sources}, script-src 'none'; frame-ancestors ${sources}`,
  );
  assert.equal(
    mergeFrameAncestors("default-src 'self', frame-ancestors 'none'", sources),
    `default-src 'self'; frame-ancestors ${sources}`,
    "a policy that only had frame-ancestors disappears",
  );
  assert.equal(
    mergeFrameAncestors("frame-ancestors-extra x", sources),
    `frame-ancestors-extra x; frame-ancestors ${sources}`,
    "only the exact directive name is replaced",
  );
});

test("qwenRequestHeaders: no cookie, Origin, browser credentials or forwarding headers; Host is the workspace", () => {
  const out = qwenRequestHeaders(
    {
      host: "192.0.2.10:3107",
      origin: "http://192.0.2.10:3107",
      cookie: "portal_session=tok; theme=dark",
      authorization: "Bearer browser-token",
      "proxy-authorization": "Basic x",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "evil",
      "x-forwarded-port": "1",
      "x-forwarded-proto": "https",
      "x-real-ip": "1.2.3.4",
      forwarded: "for=1.2.3.4",
      connection: "keep-alive",
      expect: "100-continue",
      "accept-encoding": "gzip, br",
      "content-type": "application/json",
      "content-length": "12",
      "user-agent": "test",
      "last-event-id": "7",
    },
    "172.29.128.5:4170",
    "container-token",
  );
  assert.deepEqual(out, {
    host: "172.29.128.5:4170",
    authorization: "Bearer container-token",
    "accept-encoding": "gzip, br",
    "content-type": "application/json",
    "content-length": "12",
    "user-agent": "test",
    "last-event-id": "7",
  });
});

test("qwenRequestHeaders sends no Authorization unless the gateway has one to give", () => {
  const out = qwenRequestHeaders({ host: "h:3107", authorization: "Bearer browser-token", accept: "text/html" }, "10.0.0.2:4170", null);
  assert.deepEqual(out, { host: "10.0.0.2:4170", accept: "text/html" }, "the browser's own token never goes upstream");
});

test("qwenRequestHeaders strips the WebSocket handshake fields for the relay", () => {
  const ws = qwenRequestHeaders(
    {
      host: "h:3107",
      origin: "http://h:3107",
      cookie: "portal_session=tok",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "sec-websocket-extensions": "permessage-deflate",
      "sec-websocket-protocol": "qwen-ws, qwen-bearer.abc",
      "user-agent": "test",
    },
    "10.0.0.2:4170",
    "container-token",
    { websocket: true },
  );
  assert.deepEqual(ws, { host: "10.0.0.2:4170", authorization: "Bearer container-token", "user-agent": "test" });
});

test("bearerToken reads only the Bearer scheme", () => {
  assert.equal(bearerToken("Bearer abc.DEF-_="), "abc.DEF-_=");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("  BEARER   abc  "), "abc");
  for (const bad of [undefined, "", "Bearer", "Bearer ", "Basic YTpi", "Bearer a b", "Token abc", "Bearerabc"]) {
    assert.equal(bearerToken(bad), null, String(bad));
  }
});

test("splitBearerSubprotocol takes the token out of the offer and keeps the other protocols", () => {
  assert.deepEqual(splitBearerSubprotocol(`qwen-ws, ${subprotocol("tok.en/+")}`), { token: "tok.en/+", protocols: ["qwen-ws"] });
  assert.deepEqual(splitBearerSubprotocol(`${subprotocol("t")},qwen-ws ,  other`), { token: "t", protocols: ["qwen-ws", "other"] });
  assert.deepEqual(splitBearerSubprotocol("qwen-ws"), { token: null, protocols: ["qwen-ws"] });
  assert.deepEqual(splitBearerSubprotocol(undefined), { token: null, protocols: [] });
  assert.deepEqual(splitBearerSubprotocol(" , "), { token: null, protocols: [] });
  // A bearer protocol that does not decode yields an empty token, which never matches.
  assert.deepEqual(splitBearerSubprotocol("qwen-bearer.not!base64, qwen-ws"), { token: "", protocols: ["qwen-ws"] });
  assert.deepEqual(splitBearerSubprotocol("qwen-bearer."), { token: "", protocols: [] });
  assert.equal(splitBearerSubprotocol(`${subprotocol("first")}, ${subprotocol("second")}`).token, "second");
});

test("qwenResponseHeaders strips cookies and framing denial, keeps encoding", () => {
  const out = qwenResponseHeaders(
    {
      "set-cookie": ["session=1; HttpOnly"],
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "content-encoding": "br",
      "content-type": "text/html",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      "cache-control": "no-cache",
      "www-authenticate": "Bearer",
    },
    { hostname: "192.0.2.10", webPort: 3000 },
  );
  assert.deepEqual(out, {
    "content-security-policy": "default-src 'self'; frame-ancestors http://192.0.2.10:3000 https://192.0.2.10:3000",
    "content-encoding": "br",
    "content-type": "text/html",
    "cache-control": "no-cache",
    "www-authenticate": "Bearer",
  });
  assert.equal(qwenResponseHeaders({ "content-type": "text/css" }, { hostname: "h", webPort: 3000 })["content-security-policy"], "frame-ancestors http://h:3000 https://h:3000");
  // Only the portal may frame a workspace: not another workspace's port or any other service on the host.
  assert.equal(frameAncestorSources({ hostname: "portal.example", webPort: 8443 }), "http://portal.example:8443 https://portal.example:8443");
});

test("qwenResponseHeaders makes per-user responses uncacheable, but leaves 304s alone", () => {
  const out = qwenResponseHeaders({ "content-type": "application/json", "cache-control": "max-age=600", expires: "Thu, 01 Jan 2099 00:00:00 GMT" }, { hostname: "h", webPort: 3000 }, 200);
  assert.equal(out["cache-control"], "private, no-store");
  assert.equal(out.expires, undefined);
  const notModified = qwenResponseHeaders({ etag: '"abc"' }, { hostname: "h", webPort: 3000 }, 304);
  assert.equal(notModified["cache-control"], undefined);
  assert.equal(notModified.etag, '"abc"');
});

test("workspaceCacheControl keeps revalidating or immutable policies, otherwise forbids storing", () => {
  assert.equal(workspaceCacheControl("no-cache"), "no-cache");
  assert.equal(workspaceCacheControl("public, max-age=31536000, immutable"), "public, max-age=31536000, immutable");
  assert.equal(workspaceCacheControl("no-store"), "no-store");
  assert.equal(workspaceCacheControl(undefined), "private, no-store");
  assert.equal(workspaceCacheControl("public, max-age=3600"), "private, no-store");
  assert.equal(workspaceCacheControl("max-age=60, stale-while-revalidate=30"), "private, no-store");
  assert.equal(workspaceCacheControl("x-no-cache-ish"), "private, no-store", "only whole directives count");
});

test("llmRequestHeaders swaps the placeholder key for the real one", () => {
  const incoming = {
    host: "172.29.0.1:4001",
    authorization: "Bearer portal",
    "accept-encoding": "gzip",
    "content-type": "application/json",
    connection: "keep-alive",
  };
  assert.deepEqual(llmRequestHeaders(incoming, "sk-real"), {
    authorization: "Bearer sk-real",
    "accept-encoding": "identity",
    "content-type": "application/json",
  });
  assert.deepEqual(llmRequestHeaders(incoming, ""), { "accept-encoding": "identity", "content-type": "application/json" });
});
