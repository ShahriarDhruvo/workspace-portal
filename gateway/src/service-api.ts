// Service API for workspace containers (WORKSPACE_GATEWAY_IP:SERVICE_PORT), the only address a
// workspace can reach: the LLM proxy (to LLM_UPSTREAM_URL, with the real API key added) and the
// web-search MCP server (queries SEARXNG_URL). Callers are identified by their source address;
// containers run without capabilities on a network without inter-container traffic, so they
// cannot spoof it.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { PortalDb } from "@portal/db";
import type { Config } from "./config.ts";
import { forward, type ForwardResult } from "./forward.ts";
import { endToEndHeaders, llmRequestHeaders } from "./headers.ts";
import { remoteAddress, sendError, sendJson, splitTarget } from "./http-util.ts";
import type { LlmQueue, ReleaseSlot } from "./llm-queue.ts";
import type { Logger } from "./log.ts";
import { createLimiter, handleSearchMcp, type SearchBackend } from "./search-mcp.ts";
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
  /** Maps a source address to a user id. Defaults to the addresses of running workspace containers. */
  resolveCaller?: (address: string) => number | null;
}

const LLM_PREFIX = "/llm/v1/";
const MCP_PATH = "/mcp/search";

type Limiter = ReturnType<typeof createLimiter>;

export function createServiceServer(deps: ServiceDeps): http.Server {
  const resolveCaller = deps.resolveCaller ?? ((address: string) => deps.manager.userIdForIp(address));
  // Concurrent searches per workspace, so one runaway agent can't flood the search engine.
  const limiters = new Map<number, Limiter>();
  const limiterFor = (userId: number): Limiter => {
    let limiter = limiters.get(userId);
    if (!limiter) limiters.set(userId, (limiter = createLimiter(deps.config.search.maxConcurrentPerUser)));
    return limiter;
  };
  // No request timeout: LLM streams run as long as generation does.
  return http.createServer({ requestTimeout: 0 }, (req, res) => {
    handle(deps, resolveCaller, limiterFor, req, res).catch((error: unknown) => {
      deps.log.error("service request failed", { error });
      if (!res.headersSent) sendError(res, 500, "internal", "Internal error.");
      else res.destroy();
    });
  });
}

async function handle(
  deps: ServiceDeps,
  resolveCaller: (address: string) => number | null,
  limiterFor: (userId: number) => Limiter,
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
      limiter: limiterFor(userId),
      onCall: (query) => {
        deps.manager.noteAgentActivity(userId);
        deps.log.info("web search", { userId, chars: query.query.length, page: query.page });
      },
    });
  }
  if (pathname.startsWith(LLM_PREFIX)) {
    if (!isPlainPath(pathname)) return sendError(res, 400, "bad_request", "Invalid path.");
    return proxyLlm(deps, req, res, userId, pathname, search);
  }
  return sendError(res, 404, "not_found", "Unknown route.");
}

/** No dot segments or encoded separators, so the LLM server only ever sees /v1/… paths. */
function isPlainPath(pathname: string): boolean {
  return !/%2e|%2f|%5c|\\/i.test(pathname) && new URL(pathname, "http://localhost").pathname === pathname;
}

async function proxyLlm(
  deps: ServiceDeps,
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

  const started = Date.now();
  const tapped: { parser: UsageParser | null } = { parser: null };
  let result: ForwardResult;
  try {
    result = await forward(req, res, {
      url: new URL(`${deps.config.llm.upstreamUrl}${pathname.slice("/llm".length)}${search}`),
      method,
      headers: llmRequestHeaders(req.headers, deps.config.llm.apiKey),
      responseHeaders: (incoming) => endToEndHeaders(incoming.headers),
      tap: (incoming) => {
        tapped.parser = generation ? usageParserFor(incoming.headers) : null;
        return tapped.parser ? usageTap(tapped.parser) : null;
      },
      onError: (error, response) => {
        deps.log.warn("LLM server did not answer", { userId, error });
        sendJson(response, 502, { error: { message: "The LLM server is not reachable.", type: "llm_unreachable" } });
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
