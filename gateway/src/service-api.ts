// Service API for workspace containers (WORKSPACE_GATEWAY_IP:SERVICE_PORT), the only address a
// workspace can reach: the LLM proxy (to LLM_UPSTREAM_URL, with the real API key added) and the
// web MCP server (web_search queries SEARXNG_URL; read_page asks the reader container at
// READER_URL). Callers are identified by their source address;
// containers run without capabilities on a network without inter-container traffic, so they
// cannot spoof it.
import type http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PortalDb } from "@portal/db";
import type { Config } from "./config.ts";
import { forward, type ForwardResult } from "./forward.ts";
import { endToEndHeaders, llmRequestHeaders } from "./headers.ts";
import { createStreamingServer, remoteAddress, sendError, sendJson, splitTarget } from "./http-util.ts";
import type { LlmQueue, ReleaseSlot } from "./llm-queue.ts";
import type { Logger } from "./log.ts";
import type { ReaderBackend } from "./reader.ts";
import { createLimiter, handleSearchMcp, type PageReader, type SearchBackend } from "./search-mcp.ts";
import { canonicalUrl, hostTrusted, ShownUrls, urlHost, urlsShownInLlmRequest } from "./url-policy.ts";
import { recordUsage, usageParserFor, usageTap, type UsageParser } from "./usage.ts";
import type { WorkspaceManager } from "./workspaces.ts";

export interface ServiceDeps {
  config: Config;
  db: PortalDb;
  manager: WorkspaceManager;
  llm: LlmQueue;
  log: Logger;
  /** Web search for the MCP tool (SearXNG in production). */
  search: SearchBackend;
  /** The page reader for the read_page tool; without it only web_search is offered. */
  reader?: ReaderBackend | null;
  /** Maps a source address to a user id. Defaults to the addresses of running workspace containers. */
  resolveCaller?: (address: string) => number | null;
}

const LLM_PREFIX = "/llm/v1/";
const MCP_PATH = "/mcp/search";

/**
 * The only LLM endpoints a workspace may use, by path under /v1/. The proxy adds the real API key,
 * so with a hosted provider anything else (files, batches, fine-tuning, deletions) would be every
 * workspace's to use. A model id may contain slashes (`models/Qwen/Qwen3-8B`).
 */
const LLM_ROUTES: ReadonlyArray<{ path: RegExp; method: "GET" | "POST" }> = [
  { path: /^chat\/completions$/, method: "POST" },
  { path: /^completions$/, method: "POST" },
  { path: /^embeddings$/, method: "POST" },
  { path: /^models$/, method: "GET" },
  { path: /^models\/[^/]+(?:\/[^/]+)*$/, method: "GET" },
];

type Limiter = ReturnType<typeof createLimiter>;

/** LLM request bodies larger than this are not searched for URLs (a conversation full of images). */
const URL_SCAN_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Connections one workspace may have open to this API. An agent with many subagents holds one per
 * waiting LLM request; a workspace that opens connections and never reads the answers is stopped here.
 */
const MAX_CONNECTIONS_PER_WORKSPACE = 128;

const NOT_SHOWN =
  "read_page only opens pages you were shown: a URL from web_search results, from a page you already read, or from the " +
  "conversation, plus well-known documentation and code sites. Find this page with web_search first, then open the result.";

/** Per-workspace state of the web tools. */
interface WebTools {
  /** Concurrent searches per workspace, so one runaway agent can't flood the search engines. */
  searchLimiter(userId: number): Limiter;
  /** The page reader as this workspace may use it; undefined when there is none. */
  reader(userId: number): PageReader | undefined;
  shown: ShownUrls;
  /** True when workspaces may only read pages they were shown, so the gateway has to know what that is. */
  tracksShown: boolean;
}

function createWebTools(deps: ServiceDeps): WebTools {
  const perUser = (max: number): ((userId: number) => Limiter) => {
    const limiters = new Map<number, Limiter>();
    return (userId) => {
      let limiter = limiters.get(userId);
      if (!limiter) limiters.set(userId, (limiter = createLimiter(max)));
      return limiter;
    };
  };
  const { reader: settings } = deps.config;
  const backend = deps.reader ?? null;
  // Kept for more workspaces than can run at once; one that was dropped is shown its conversation
  // again by its next LLM request.
  const shown = new ShownUrls({ users: Math.max(16, deps.config.maxRunning * 4) });
  const readLimiter = perUser(settings.maxConcurrentPerUser);
  const tracksShown = backend !== null && settings.policy === "shown";
  return {
    searchLimiter: perUser(deps.config.search.maxConcurrentPerUser),
    shown,
    tracksShown,
    reader(userId) {
      if (backend === null) return undefined;
      return {
        backend,
        limiter: readLimiter(userId),
        pageChars: settings.pageChars,
        access(requested) {
          // The reader is asked for exactly the URL that is checked here, never for the model's own spelling of it.
          const url = canonicalUrl(requested);
          const host = url === null ? null : urlHost(url);
          if (url === null || host === null) return { refusal: "That is not a valid http(s) URL." };
          if (!tracksShown) return { url, redirectHosts: null };
          // A URL the workspace was shown says nothing the model chose, wherever it leads. It is requested as it was shown.
          const asShown = shown.find(userId, url);
          if (asShown !== null) return { url: asShown, redirectHosts: null };
          // On a trusted site the model may have written the URL itself: it must not be passed on elsewhere.
          if (hostTrusted(host, settings.trustedHosts)) return { url, redirectHosts: settings.trustedHosts };
          deps.log.info("page read refused: not a URL the workspace was shown", { userId, host });
          return { refusal: NOT_SHOWN };
        },
        onCall(request) {
          deps.manager.noteAgentActivity(userId);
          deps.log.info("page read", { userId, host: urlHost(request.url), start: request.start });
        },
      };
    },
  };
}

export function createServiceServer(deps: ServiceDeps): http.Server {
  const resolveCaller = deps.resolveCaller ?? ((address: string) => deps.manager.userIdForIp(address));
  const web = createWebTools(deps);
  // LLM streams run as long as generation does.
  const server = createStreamingServer((req, res) => {
    handle(deps, resolveCaller, web, req, res).catch((error: unknown) => {
      deps.log.error("service request failed", { error });
      if (!res.headersSent) sendError(res, 500, "internal", "Internal error.");
      else res.destroy();
    });
  });
  const open = new Map<string, number>();
  server.on("connection", (socket) => {
    const address = socket.remoteAddress ?? "";
    const count = (open.get(address) ?? 0) + 1;
    if (count > MAX_CONNECTIONS_PER_WORKSPACE) return void socket.destroy();
    open.set(address, count);
    socket.once("close", () => {
      const left = (open.get(address) ?? 1) - 1;
      if (left > 0) open.set(address, left);
      else open.delete(address);
    });
  });
  return server;
}

async function handle(
  deps: ServiceDeps,
  resolveCaller: (address: string) => number | null,
  web: WebTools,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const userId = resolveCaller(remoteAddress(req));
  if (userId === null) return sendError(res, 403, "forbidden", "Unknown caller.");
  const target = req.url ?? "";
  if (!target.startsWith("/")) return sendError(res, 400, "bad_request", "Unsupported request target.");
  const { pathname, search } = splitTarget(target);
  if (pathname === MCP_PATH) {
    return handleSearchMcp(req, res, {
      backend: deps.search,
      limiter: web.searchLimiter(userId),
      reader: web.reader(userId),
      onShown: web.tracksShown ? (urls) => web.shown.add(userId, urls) : undefined,
      onCall: (query) => {
        deps.manager.noteAgentActivity(userId);
        deps.log.info("web search", { userId, chars: query.query.length, page: query.page });
      },
    });
  }
  if (pathname.startsWith(LLM_PREFIX)) {
    if (!isPlainPath(pathname)) return sendError(res, 400, "bad_request", "Invalid path.");
    const method = req.method ?? "GET";
    const allowed = LLM_ROUTES.filter((route) => route.path.test(pathname.slice(LLM_PREFIX.length)));
    if (allowed.length === 0) return sendLlmError(res, 404, "not_found", `${pathname} is not available to workspaces.`);
    if (!allowed.some((route) => route.method === method)) {
      const allow = allowed.map((route) => route.method).join(", ");
      return sendLlmError(res, 405, "method_not_allowed", `Use ${allow} for ${pathname}.`, { allow });
    }
    return proxyLlm(deps, web, req, res, userId, pathname, search);
  }
  return sendError(res, 404, "not_found", "Unknown route.");
}

/** The error shape OpenAI clients understand (the LLM server's own errors pass through as they are). */
function sendLlmError(res: ServerResponse, status: number, type: string, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { error: { message, type } }, headers);
}

/** No dot segments or encoded separators, so the LLM server only ever sees /v1/… paths. */
function isPlainPath(pathname: string): boolean {
  return !/%2e|%2f|%5c|\\/i.test(pathname) && new URL(pathname, "http://localhost").pathname === pathname;
}

/**
 * Collects a request body as it streams by and, once it has all arrived, hands over the URLs in it
 * that the model is being shown.
 */
function shownUrlCollector(onUrls: (urls: string[]) => void): { observe: (chunk: Buffer) => void; finish: () => void } {
  let chunks: Buffer[] | null = [];
  let size = 0;
  return {
    observe(chunk) {
      if (chunks === null) return;
      size += chunk.length;
      if (size > URL_SCAN_LIMIT_BYTES) chunks = null;
      else chunks.push(chunk);
    },
    finish() {
      const body = chunks;
      chunks = null;
      if (body !== null && size > 0) onUrls(urlsShownInLlmRequest(Buffer.concat(body)));
    },
  };
}

async function proxyLlm(
  deps: ServiceDeps,
  web: WebTools,
  req: IncomingMessage,
  res: ServerResponse,
  userId: number,
  pathname: string,
  search: string,
): Promise<void> {
  const method = req.method ?? "GET";
  // Generation requests wait for a slot; GET (model listing) never queues behind them.
  const generation = method !== "GET" && method !== "HEAD";
  deps.manager.noteAgentActivity(userId);

  let release: ReleaseSlot = () => undefined;
  if (generation) {
    const hangUp = new AbortController();
    const onClose = (): void => hangUp.abort();
    res.once("close", onClose);
    try {
      release = await deps.llm.acquire(userId, hangUp.signal);
    } catch {
      return; // the workspace hung up while queued
    } finally {
      res.off("close", onClose);
    }
    if (req.socket.destroyed) {
      release();
      return;
    }
  }

  // What the model is shown in this request (the user's messages, tool output) it may then open with
  // read_page. The body has arrived in full before the model can answer, let alone call a tool.
  const collector = generation && web.tracksShown ? shownUrlCollector((urls) => web.shown.add(userId, urls)) : null;
  if (collector) {
    req.once("end", () => {
      try {
        collector.finish();
      } catch (error) {
        deps.log.warn("could not read the URLs in an LLM request", { userId, error });
      }
    });
  }

  const started = Date.now();
  const tapped: { parser: UsageParser | null } = { parser: null };
  let result: ForwardResult;
  try {
    result = await forward(req, res, {
      url: new URL(`${deps.config.llm.upstreamUrl}${pathname.slice("/llm".length)}${search}`),
      method,
      headers: llmRequestHeaders(req.headers, deps.config.llm.apiKey),
      observeBody: collector?.observe,
      responseHeaders: (incoming) => endToEndHeaders(incoming.headers),
      tap: (incoming) => {
        tapped.parser = generation ? usageParserFor(incoming.headers) : null;
        return tapped.parser ? usageTap(tapped.parser) : null;
      },
      onError: (error, response) => {
        deps.log.warn("LLM server did not answer", { userId, error });
        sendLlmError(response, 502, "llm_unreachable", "The LLM server is not reachable.");
      },
    });
  } finally {
    release();
    deps.manager.noteAgentActivity(userId);
  }

  const usage = tapped.parser?.usage ?? null;
  if (generation && result.status !== null && result.status >= 200 && result.status < 300) {
    try {
      recordUsage(deps.db, userId, usage);
    } catch (error) {
      deps.log.error("could not record LLM usage", { userId, error });
    }
  }
  deps.log.info("llm request", {
    userId,
    method,
    path: pathname,
    status: result.status,
    outcome: result.outcome,
    ms: Date.now() - started,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
  });
}
