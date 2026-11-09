// The web search tool workspaces get: a minimal, stateless MCP server (streamable HTTP transport,
// JSON responses) with one tool, `web_search`, answered from the configured SearXNG instance.
//
// This replaces a separate search container on purpose. Workspaces have no network access except
// the gateway, and the gateway only ever sends a search query to SEARXNG_URL: there is no tool that
// fetches arbitrary URLs, so a workspace cannot use search to reach anything else.
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http-util.ts";

/** Protocol versions this server speaks; it answers with the client's if listed, else the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SERVER_INFO = { name: "workspace-portal-search", version: "1.0.0" };
const BODY_LIMIT_BYTES = 64 * 1024;
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 500;
const MAX_QUERY_CHARS = 400;
const TIME_RANGES = ["day", "week", "month", "year"] as const;

export const WEB_SEARCH_TOOL = {
  name: "web_search",
  title: "Web search",
  description:
    "Search the web through the organization's private SearXNG instance. Returns titles, URLs and " +
    "short snippets. This is the only internet access available: pages cannot be opened or downloaded, " +
    "so rely on the snippets and refine the query (or ask for page 2) when they are not enough.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for.", minLength: 1, maxLength: MAX_QUERY_CHARS },
      page: { type: "integer", description: "Result page, starting at 1.", minimum: 1, maximum: 10 },
      time_range: { type: "string", enum: [...TIME_RANGES], description: "Only results from the last day, week, month or year." },
      language: { type: "string", description: "Language code such as en or de-CH. Default: all languages." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
} as const;

export interface SearchQuery {
  query: string;
  page: number;
  timeRange: (typeof TIME_RANGES)[number] | null;
  language: string | null;
}

export interface SearchBackend {
  /** Runs one search; throws SearchError with a message meant for the model. */
  search(query: SearchQuery, signal: AbortSignal): Promise<string>;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type JsonRpcId = string | number;

const isId = (value: unknown): value is JsonRpcId => typeof value === "string" || typeof value === "number";
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export interface SearchMcpOptions {
  backend: SearchBackend;
  /** Called for every valid tool call, before it runs (activity, logging). */
  onCall?: (query: SearchQuery) => void;
  /** Concurrent searches allowed per workspace. */
  limiter: { tryAcquire(): (() => void) | null };
}

/** Handles one HTTP request to the search MCP endpoint. */
export async function handleSearchMcp(req: IncomingMessage, res: ServerResponse, options: SearchMcpOptions): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "POST") {
    // Stateless server: no server-initiated stream (GET) and no session to end (DELETE).
    res.writeHead(405, { allow: "POST", "content-length": 0, "cache-control": "no-store" });
    res.end();
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req, BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) return sendJson(res, 413, rpcError(null, -32600, error.message));
    return sendJson(res, 400, rpcError(null, -32700, "Parse error."));
  }
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return sendJson(res, 400, rpcError(null, -32600, "Empty batch."));

  const responses: unknown[] = [];
  for (const message of messages) {
    const response = await handleMessage(message as JsonRpcMessage, options, req);
    if (response !== null) responses.push(response);
  }
  if (responses.length === 0) {
    // Only notifications or responses: accepted, nothing to say.
    res.writeHead(202, { "content-length": 0, "cache-control": "no-store" });
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
}

async function handleMessage(message: JsonRpcMessage, options: SearchMcpOptions, req: IncomingMessage): Promise<unknown> {
  if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid request.");
  }
  if (typeof message.method !== "string") return null; // a response to us; we never ask anything
  if (!isId(message.id)) return null; // notification (initialized, cancelled, …)
  const id = message.id;
  switch (message.method) {
    case "initialize": {
      const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested as never) ? requested : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Use web_search for anything on the internet; it is the only way out of this workspace.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [WEB_SEARCH_TOOL] });
    case "tools/call":
      return rpcResult(id, await callTool(message.params, options, req));
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

async function callTool(params: unknown, options: SearchMcpOptions, req: IncomingMessage): Promise<unknown> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (name !== WEB_SEARCH_TOOL.name) return toolError(`Unknown tool: ${String(name)}`);
  const parsed = parseSearchArguments(args);
  if (typeof parsed === "string") return toolError(parsed);
  options.onCall?.(parsed);
  const release = options.limiter.tryAcquire();
  if (!release) return toolError("Too many searches are running at once; wait for one to finish and try again.");
  const abort = new AbortController();
  const onClose = (): void => abort.abort();
  req.socket.once("close", onClose);
  try {
    return { content: [{ type: "text", text: await options.backend.search(parsed, abort.signal) }] };
  } catch (error) {
    return toolError(error instanceof SearchError ? error.message : "The search failed.");
  } finally {
    req.socket.off("close", onClose);
    release();
  }
}

const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

/** Validates tool arguments; returns an error message for the model on bad input. */
export function parseSearchArguments(args: unknown): SearchQuery | string {
  if (args === null || typeof args !== "object") return "Provide a query.";
  const { query, page, time_range: timeRange, language } = args as Record<string, unknown>;
  if (typeof query !== "string" || query.trim() === "") return "Provide a non-empty query.";
  if (query.length > MAX_QUERY_CHARS) return `Keep the query under ${MAX_QUERY_CHARS} characters.`;
  if (page !== undefined && (!Number.isInteger(page) || (page as number) < 1 || (page as number) > 10)) return "page must be 1–10.";
  if (timeRange !== undefined && !TIME_RANGES.includes(timeRange as never)) return "time_range must be day, week, month or year.";
  if (language !== undefined && (typeof language !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language))) {
    return "language must be a code such as en or pt-BR.";
  }
  return {
    query: query.trim(),
    page: (page as number | undefined) ?? 1,
    timeRange: (timeRange as SearchQuery["timeRange"] | undefined) ?? null,
    language: (language as string | undefined) ?? null,
  };
}

// ------------------------------------------------------------------ SearXNG backend

interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engines?: unknown;
  publishedDate?: unknown;
}

interface SearxngResponse {
  results?: SearxngResult[];
  answers?: unknown[];
  suggestions?: unknown[];
  infoboxes?: Array<{ infobox?: unknown; content?: unknown; id?: unknown }>;
  number_of_results?: unknown;
}

export interface SearxngOptions {
  /** Base URL of the SearXNG instance (its /search endpoint must allow format=json). */
  baseUrl: string;
  /** Optional Authorization header value for instances behind auth. */
  authorization: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createSearxngBackend(options: SearxngOptions): SearchBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async search(query, signal) {
      const url = new URL("search", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
      url.searchParams.set("q", query.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", String(query.page));
      if (query.timeRange) url.searchParams.set("time_range", query.timeRange);
      if (query.language) url.searchParams.set("language", query.language);
      const headers: Record<string, string> = { accept: "application/json", "user-agent": "workspace-portal-search/1.0" };
      if (options.authorization) headers.authorization = options.authorization;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
        });
      } catch {
        throw new SearchError("The search engine did not answer. Try again in a moment.");
      }
      if (response.status === 403) {
        throw new SearchError("The search engine refused the request (is the JSON format enabled in SearXNG's settings?).");
      }
      if (response.status === 429) throw new SearchError("The search engine is rate-limiting requests. Wait a little and try again.");
      if (!response.ok) throw new SearchError(`The search engine answered with HTTP ${response.status}.`);
      let data: SearxngResponse;
      try {
        data = (await response.json()) as SearxngResponse;
      } catch {
        throw new SearchError("The search engine returned something that is not JSON.");
      }
      return formatResults(query, data);
    },
  };
}

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Plain-text results for the model. */
export function formatResults(query: SearchQuery, data: SearxngResponse): string {
  const lines: string[] = [];
  const answers = (data.answers ?? []).map(text).filter(Boolean);
  if (answers.length > 0) lines.push(`Answer: ${answers.join(" | ")}`, "");
  for (const box of data.infoboxes ?? []) {
    const title = text(box.infobox);
    const content = clip(text(box.content), MAX_SNIPPET_CHARS);
    if (title || content) lines.push(`Infobox — ${title}${content ? `: ${content}` : ""}`, "");
  }
  const results = (data.results ?? []).filter((result) => text(result.url)).slice(0, MAX_RESULTS);
  if (results.length === 0) {
    lines.push(`No results for "${query.query}"${query.page > 1 ? ` on page ${query.page}` : ""}.`);
  } else {
    lines.push(`Results for "${query.query}" (page ${query.page}):`, "");
    results.forEach((result, index) => {
      lines.push(`${index + 1}. ${text(result.title) || "(untitled)"}`);
      lines.push(`   ${text(result.url)}`);
      const snippet = clip(text(result.content), MAX_SNIPPET_CHARS);
      if (snippet) lines.push(`   ${snippet}`);
      const published = text(result.publishedDate);
      if (published) lines.push(`   Published: ${published}`);
      lines.push("");
    });
  }
  const suggestions = (data.suggestions ?? []).map(text).filter(Boolean).slice(0, 8);
  if (suggestions.length > 0) lines.push(`Related searches: ${suggestions.join("; ")}`);
  return lines.join("\n").trim();
}

/** At most `max` concurrent holders. */
export function createLimiter(max: number): { tryAcquire(): (() => void) | null } {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= max) return null;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
  };
}
