// Service API for workspace containers, one server per workspace kind on the host's address on that kind's network
// (Private: WORKSPACE_GATEWAY_IP:SERVICE_PORT, the only address a Private workspace can reach; Online:
// ONLINE_GATEWAY_IP:SERVICE_PORT): the LLM proxy (to LLM_UPSTREAM_URL, with the real API key added) and the web MCP
// server (web_search queries SEARXNG_URL, after Exa when EXA_SEARCH is on; read_page asks the reader container at
// READER_URL). Callers are identified by their source address, among the running containers of this server's kind
// only; containers run without capabilities on networks without inter-container traffic, so they cannot spoof it.
// This API is all that workspaces have in common, and what it keeps is kept apart: the URLs a workspace was shown
// are that workspace's alone (not its user's other agents'), the search and read slots each user's, and each
// server's state its own: none carries over to the other kind.
import type http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { workspaceNumber, type PortalDb, type WorkspaceKind, type WorkspaceRef } from "@portal/core";
import type { Config } from "../config.ts";
import { createStreamingServer, remoteAddress, sendError, sendJson, splitTarget } from "../lib/http-util.ts";
import { isPlainPath, proxyLlm, sendLlmError } from "./llm-proxy.ts";
import type { LlmQueue } from "./llm-queue.ts";
import { fetchLoadedModels, type MediaCatalog } from "./media-catalog.ts";
import { MEDIA_ROUTES } from "./media-routes.ts";
import { videoHold } from "./video-jobs.ts";
import type { VideoJobs } from "./video-jobs.ts";
import type { LlmRequests } from "../monitor/llm-requests.ts";
import type { Logger } from "../lib/log.ts";
import type { ReaderBackend } from "./reader.ts";
import { createLimiter, handleSearchMcp, type Limiter, type PageReader, type SearchBackend } from "./search-mcp.ts";
import { canonicalUrl, hostTrusted, ShownUrls, urlHost, urlsShownInLlmRequest } from "./url-policy.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";

export interface ServiceDeps {
  /** The workspaces this server answers: those on its kind's network, where it listens. */
  kind: WorkspaceKind;
  config: Config;
  db: PortalDb;
  manager: WorkspaceManager;
  llm: LlmQueue;
  /** Where each generation request reports its progress, for the admin's live view. */
  requests: LlmRequests;
  videoJobs: VideoJobs;
  log: Logger;
  /** Web search for the MCP tool (in production SearXNG, behind Exa when that is on). */
  search: SearchBackend;
  /** The page reader for the read_page tool; without it only web_search is offered. */
  reader?: ReaderBackend | null;
  /** The workspace calling from a source address. Defaults to the running workspace containers of `kind`. */
  resolveCaller?: CallerResolver;
  /** The models the AI server has loaded now (media-catalog.ts), for GET /llm/v1/media. */
  loadedModels?: () => Promise<string[] | null>;
}

type CallerResolver = (address: string) => { userId: number; ref: WorkspaceRef } | null;

const LLM_PREFIX = "/llm/v1/";
const MCP_PATH = "/mcp/search";

/** The image and media models, for the portal's media tools (media-catalog.ts). */
const MEDIA_CATALOG_PATH = "media";

/**
 * The image models' routes (media.json's image), under the same queue as the LLM. Their prompt is the model's own writing,
 * not something it was shown, so its URLs are not added to what read_page may open.
 */
const IMAGE_ROUTE = /^images\/(?:generations|edits)$/;

/**
 * The only LLM endpoints a workspace may use, by path under /v1/. The proxy adds the real API key, so with a hosted
 * provider anything else (files, batches, fine-tuning, deletions) would be every workspace's to use. A model id may
 * contain slashes (`models/Qwen/Qwen3-8B`).
 */
const LLM_ROUTES: ReadonlyArray<{ path: RegExp; method: "GET" | "POST" }> = [
  { path: /^chat\/completions$/, method: "POST" },
  { path: /^completions$/, method: "POST" },
  { path: /^embeddings$/, method: "POST" },
  { path: IMAGE_ROUTE, method: "POST" },
  { path: /^models$/, method: "GET" },
  { path: /^models\/[^/]+(?:\/[^/]+)*$/, method: "GET" },
];

/**
 * The routes of the media models the AI server has (media.json). Like an image prompt, what a media request carries
 * is the model's own writing or a file of the project, not something it was shown.
 */
function mediaRoutes(config: Config): ReadonlyArray<{ path: RegExp; method: "GET" | "POST" | "DELETE" }> {
  return MEDIA_ROUTES.filter((route) => config.llm.media[route.kind] !== undefined);
}

/** LLM request bodies larger than this are not searched for URLs (a conversation full of images). */
const URL_SCAN_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Connections one workspace may have open to this API. An agent with many subagents holds one per waiting LLM
 * request; a workspace that opens them and never reads the answers stops here.
 */
const MAX_CONNECTIONS_PER_WORKSPACE = 128;

const NOT_SHOWN =
  "read_page only opens pages you were shown: a URL from web_search results, from a page you already read, or from the " +
  "conversation, plus well-known documentation and code sites. Find this page with web_search first, then open the result.";

/** The web tools' state: per user, and for what a workspace was shown per workspace (`workspace`: its number). */
interface WebTools {
  /** Concurrent searches per user, so one runaway agent can't flood the search engines. */
  searchLimiter(userId: number): Limiter;
  /** The page reader as this workspace may use it; undefined when there is none. */
  reader(userId: number, workspace: number): PageReader | undefined;
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
  // Kept for more workspaces than can run at once; one that was dropped is shown its conversation again by its next LLM request.
  const shown = new ShownUrls({ workspaces: Math.max(16, deps.config.maxRunning * 4) });
  const readLimiter = perUser(settings.maxConcurrentPerUser);
  const tracksShown = backend !== null && settings.policy === "shown";
  return {
    searchLimiter: perUser(deps.config.search.maxConcurrentPerUser),
    shown,
    tracksShown,
    reader(userId, workspace) {
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
          const asShown = shown.find(workspace, url);
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
  const resolveCaller = deps.resolveCaller ?? ((address: string) => deps.manager.workspaceForIp(deps.kind, address));
  const web = createWebTools(deps);
  const media = mediaRoutes(deps.config);
  const routes = [...LLM_ROUTES, ...media];
  const server = createStreamingServer(deps.log, "service", (req, res) => handle(deps, resolveCaller, web, { routes, media }, req, res));
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
  resolveCaller: CallerResolver,
  web: WebTools,
  { routes, media }: { routes: ReadonlyArray<{ path: RegExp; method: string }>; media: ReadonlyArray<{ path: RegExp }> },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const caller = resolveCaller(remoteAddress(req));
  if (caller === null) return sendError(res, 403, "forbidden", "Unknown caller.");
  const { userId } = caller;
  const workspace = workspaceNumber(userId, caller.ref);
  const target = req.url ?? "";
  if (!target.startsWith("/")) return sendError(res, 400, "bad_request", "Unsupported request target.");
  const { pathname, search } = splitTarget(target);
  if (pathname === MCP_PATH) {
    return handleSearchMcp(req, res, {
      backend: deps.search,
      limiter: web.searchLimiter(userId),
      reader: web.reader(userId, workspace),
      onShown: web.tracksShown ? (urls) => web.shown.add(workspace, urls) : undefined,
      onCall: (query) => {
        deps.manager.noteAgentActivity(userId);
        deps.log.info("web search", { userId, chars: query.query.length, page: query.page });
      },
    });
  }
  if (pathname.startsWith(LLM_PREFIX)) {
    if (!isPlainPath(pathname)) return sendError(res, 400, "bad_request", "Invalid path.");
    const method = req.method ?? "GET";
    const llmPath = pathname.slice(LLM_PREFIX.length);
    if (llmPath === MEDIA_CATALOG_PATH) {
      if (method !== "GET") return sendLlmError(res, 405, "method_not_allowed", `Use GET for ${pathname}.`, { allow: "GET" });
      const loaded = deps.loadedModels ?? (() => fetchLoadedModels(deps.config.llm.upstreamUrl, deps.config.llm.apiKey));
      const catalog: MediaCatalog = { kinds: deps.config.llm.media, loaded: await loaded(), videoHold: videoHold(deps.videoJobs, deps.llm, userId, Date.now()) };
      return sendJson(res, 200, catalog);
    }
    const allowed = routes.filter((entry) => entry.path.test(llmPath));
    if (allowed.length === 0) return sendLlmError(res, 404, "not_found", `${pathname} is not available to workspaces.`);
    if (!allowed.some((route) => route.method === method)) {
      const allow = allowed.map((route) => route.method).join(", ");
      return sendLlmError(res, 405, "method_not_allowed", `Use ${allow} for ${pathname}.`, { allow });
    }
    deps.manager.noteAgentActivity(userId);
    // What the model is shown in a request (the user's messages, tool output) it may then open with read_page. The
    // body has arrived in full before the model can answer, let alone call a tool.
    const shows = method === "POST" && web.tracksShown && !IMAGE_ROUTE.test(llmPath) && !media.some((entry) => entry.path.test(llmPath));
    const collector = shows ? shownUrlCollector((urls) => web.shown.add(workspace, urls)) : null;
    if (collector) {
      req.once("end", () => {
        try {
          collector.finish();
        } catch (error) {
          deps.log.warn("could not read the URLs in an LLM request", { userId, error });
        }
      });
    }
    try {
      return await proxyLlm(deps, req, res, { caller: { userId, keyId: null }, pathname: pathname.slice("/llm".length), search, observeBody: collector?.observe });
    } finally {
      deps.manager.noteAgentActivity(userId);
    }
  }
  return sendError(res, 404, "not_found", "Unknown route.");
}

/** Collects a request body as it streams by and, once it has all arrived, hands over the URLs in it that the model is being shown. */
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
