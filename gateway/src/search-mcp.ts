// The web tools workspaces get: a minimal, stateless MCP server (streamable HTTP transport, JSON
// responses) with `web_search`, answered from the configured SearXNG instance, and, when a page
// reader is configured, `read_page` (reader.ts).
//
// Workspaces have no network access except the gateway. A search only ever sends a query to
// SEARXNG_URL. A page is fetched by the reader container, never by the gateway or the workspace,
// and only when the workspace is allowed to open that URL (url-policy.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http-util.ts";
import { formatPage, parseReadArguments, ReadError, readPageTool, type ReaderBackend, type ReadRequest } from "./reader.ts";
import { canonicalUrl, extractUrls } from "./url-policy.ts";

/** Protocol versions this server speaks; it answers with the client's if listed, else the newest. */
const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SERVER_INFO = { name: "workspace-portal-search", version: "1.1.0" };
const BODY_LIMIT_BYTES = 64 * 1024;
/** Messages in one JSON-RPC batch. Every answer is held in memory until the client has taken it. */
const MAX_BATCH = 8;
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 500;
const MAX_QUERY_CHARS = 400;
const TIME_RANGES = ["day", "week", "month", "year"] as const;

const SEARCH_ONLY_DESCRIPTION =
  "Search the web through the organization's private SearXNG instance. Returns titles, URLs and " +
  "short snippets. This is the only internet access available: pages cannot be opened or downloaded, " +
  "so rely on the snippets and refine the query (or ask for page 2) when they are not enough.";
const SEARCH_AND_READ_DESCRIPTION =
  "Search the web through the organization's private SearXNG instance. Returns titles, URLs and " +
  "short snippets. When a snippet is not enough, open the result with read_page, refine the query, or ask for page 2.";

const WEB_SEARCH_TOOL = {
  name: "web_search",
  title: "Web search",
  description: SEARCH_ONLY_DESCRIPTION,
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

type Limiter = { tryAcquire(): (() => void) | null };

/** The page reader as one workspace may use it. */
export interface PageReader {
  backend: ReaderBackend;
  /** Concurrent page reads allowed per workspace. */
  limiter: Limiter;
  /** Characters of a page returned per call. */
  pageChars: number;
  /**
   * Whether this workspace may open the URL: a refusal (a message for the model), or the URL to
   * ask the reader for (the checked spelling, never the model's own) and the sites a redirect from
   * it may lead to (null: anywhere).
   */
  access(url: string): { refusal: string } | { url: string; redirectHosts: readonly string[] | null };
  /** Called for every valid read, before it runs (activity, logging). */
  onCall?: (request: ReadRequest) => void;
}

export interface SearchMcpOptions {
  backend: SearchBackend;
  /** Called for every valid tool call, before it runs (activity, logging). */
  onCall?: (query: SearchQuery) => void;
  /** Concurrent searches allowed per workspace. */
  limiter: Limiter;
  /** Offers read_page when set. */
  reader?: PageReader;
  /** Called with the URLs in every answer a tool gives: from then on the workspace has been shown them. */
  onShown?: (urls: string[]) => void;
}

function toolsFor(options: SearchMcpOptions): unknown[] {
  if (!options.reader) return [WEB_SEARCH_TOOL];
  return [{ ...WEB_SEARCH_TOOL, description: SEARCH_AND_READ_DESCRIPTION }, readPageTool(options.reader.pageChars)];
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
  if (messages.length > MAX_BATCH) return sendJson(res, 400, rpcError(null, -32600, `Send at most ${MAX_BATCH} messages in one batch.`));

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
        instructions: options.reader
          ? "Use web_search to find things on the internet and read_page to open a result; they are the only way out of this workspace."
          : "Use web_search for anything on the internet; it is the only way out of this workspace.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolsFor(options) });
    case "tools/call":
      return rpcResult(id, await callTool(message.params, options, req));
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

async function callTool(params: unknown, options: SearchMcpOptions, req: IncomingMessage): Promise<unknown> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (name === "read_page" && options.reader) return readPage(args, options, options.reader, req);
  if (name !== WEB_SEARCH_TOOL.name) return toolError(`Unknown tool: ${String(name)}`);
  const parsed = parseSearchArguments(args);
  if (typeof parsed === "string") return toolError(parsed);
  options.onCall?.(parsed);
  const release = options.limiter.tryAcquire();
  if (!release) return toolError("Too many searches are running at once; wait for one to finish and try again.");
  try {
    const text = await untilClosed(req, (signal) => options.backend.search(parsed, signal));
    options.onShown?.(urlsFound(text, parsed.query));
    return toolText(text);
  } catch (error) {
    return toolError(error instanceof SearchError ? error.message : "The search failed.");
  } finally {
    release();
  }
}

/**
 * The URLs a search answer shows the model: those of the results, not the ones the model wrote
 * into its own query. The answer repeats the query ('No results for "..."'), and a search engine
 * may repeat it in a spelling correction, so a URL in the query proves nothing about what is on
 * the web.
 */
export function urlsFound(answer: string, query: string): string[] {
  const own = new Set(extractUrls(query).map(canonicalUrl));
  const results = answer
    .split("\n")
    .filter((line) => !line.startsWith("Did you mean: "))
    .join("\n");
  return extractUrls(results).filter((url) => !own.has(canonicalUrl(url)));
}

async function readPage(args: unknown, options: SearchMcpOptions, reader: PageReader, req: IncomingMessage): Promise<unknown> {
  const parsed = parseReadArguments(args);
  if (typeof parsed === "string") return toolError(parsed);
  reader.onCall?.(parsed);
  const access = reader.access(parsed.url);
  if ("refusal" in access) return toolError(access.refusal);
  const release = reader.limiter.tryAcquire();
  if (!release) return toolError("Too many pages are being read at once; wait for one to finish and try again.");
  // The download is not tied to this connection (another workspace may be waiting for the same
  // page), so the slot is held until the download itself ends: a workspace that hangs up and asks
  // again does not get more downloads going than its limit.
  const download = reader.backend.read(access.url, new AbortController().signal, { redirectHosts: access.redirectHosts });
  download.then(release, release);
  try {
    const page = await untilClosed(req, (signal) => Promise.race([download, cancelled(signal)]));
    const text = formatPage(page, parsed.start, reader.pageChars);
    options.onShown?.([page.url, ...extractUrls(text)]);
    return toolText(text);
  } catch (error) {
    return toolError(error instanceof ReadError ? error.message : "The page could not be read.");
  }
}

function cancelled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(new ReadError("The read was cancelled."));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Runs `work` with a signal that aborts when the caller's connection closes. */
async function untilClosed<T>(req: IncomingMessage, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const onClose = (): void => abort.abort();
  req.socket.once("close", onClose);
  try {
    return await work(abort.signal);
  } finally {
    req.socket.off("close", onClose);
  }
}

const toolText = (text: string) => ({ content: [{ type: "text", text }] });

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
  /** "Did you mean" spellings of the query. */
  corrections?: unknown[];
  infoboxes?: Array<{ infobox?: unknown; content?: unknown; id?: unknown }>;
  number_of_results?: unknown;
  /** [engine, reason] for every engine that was asked and did not answer. */
  unresponsive_engines?: unknown[];
}

export interface SearxngOptions {
  /** Base URL of the SearXNG instance (its /search endpoint must allow format=json). */
  baseUrl: string;
  /** Optional Authorization header value for instances behind auth. */
  authorization: string;
  timeoutMs: number;
  /**
   * Engines asked by name, once, when a search comes back with fewer than `fallbackBelow` results.
   * They can be engines SearXNG has loaded but does not use by default (disabled: true).
   */
  fallbackEngines?: readonly string[];
  fallbackBelow?: number;
  /** How long an answer with results is reused for the same search; 0 turns the cache off. */
  cacheMs?: number;
  /** Told about every fallback request: how many results there were before and after it (after is null when it failed). */
  onFallback?: (use: { before: number; after: number | null }) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const MAX_CACHED_SEARCHES = 256;

export function createSearxngBackend(options: SearxngOptions): SearchBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const fallbackEngines = options.fallbackEngines ?? [];
  const fallbackBelow = options.fallbackBelow ?? 3;
  const cacheMs = options.cacheMs ?? 0;
  const cache = new Map<string, { expires: number; text: string }>();

  async function ask(query: SearchQuery, engines: readonly string[] | null, signal: AbortSignal): Promise<SearxngResponse> {
    const url = new URL("search", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    url.searchParams.set("q", query.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", String(query.page));
    if (query.timeRange) url.searchParams.set("time_range", query.timeRange);
    if (query.language) url.searchParams.set("language", query.language);
    if (engines) url.searchParams.set("engines", engines.join(","));
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
    try {
      return (await response.json()) as SearxngResponse;
    } catch {
      throw new SearchError("The search engine returned something that is not JSON.");
    }
  }

  return {
    async search(query, signal) {
      const key = JSON.stringify([query.query.toLowerCase(), query.page, query.timeRange, query.language]);
      const cached = cache.get(key);
      if (cached) {
        if (cached.expires > now()) return cached.text;
        cache.delete(key);
      }
      let data = await ask(query, null, signal);
      if (fallbackEngines.length > 0 && usableResults(data).length < fallbackBelow) {
        const before = usableResults(data).length;
        try {
          data = mergeResponses(data, await ask(query, fallbackEngines, signal));
          options.onFallback?.({ before, after: usableResults(data).length });
        } catch {
          // The first answer stands, thin as it is.
          options.onFallback?.({ before, after: null });
        }
      }
      const answer = formatResults(query, data);
      if (cacheMs > 0 && usableResults(data).length > 0) {
        cache.set(key, { expires: now() + cacheMs, text: answer });
        if (cache.size > MAX_CACHED_SEARCHES) cache.delete(cache.keys().next().value!);
      }
      return answer;
    },
  };
}

const usableResults = (data: SearxngResponse): SearxngResult[] => (data.results ?? []).filter((result) => text(result.url));

/** The first answer with the second one's new results after it; both lists of engines that failed. */
function mergeResponses(first: SearxngResponse, second: SearxngResponse): SearxngResponse {
  const seen = new Set(usableResults(first).map((result) => text(result.url)));
  const extra = usableResults(second).filter((result) => !seen.has(text(result.url)));
  return {
    results: [...usableResults(first), ...extra],
    answers: first.answers?.length ? first.answers : second.answers,
    infoboxes: first.infoboxes?.length ? first.infoboxes : second.infoboxes,
    corrections: first.corrections?.length ? first.corrections : second.corrections,
    unresponsive_engines: [...(first.unresponsive_engines ?? []), ...(second.unresponsive_engines ?? [])],
  };
}

/** "brave (too many requests), duckduckgo (CAPTCHA)" for the engines that were asked and failed. */
function failedEngines(data: SearxngResponse): string {
  const failures = new Map<string, string>();
  for (const entry of data.unresponsive_engines ?? []) {
    if (!Array.isArray(entry)) continue;
    const engine = text(entry[0]);
    if (engine) failures.set(engine, text(entry[1]).replace(/^Suspended: /, ""));
  }
  return [...failures].map(([engine, reason]) => (reason ? `${engine} (${reason})` : engine)).join(", ");
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
  const results = usableResults(data).slice(0, MAX_RESULTS);
  if (results.length === 0) {
    lines.push(`No results for "${query.query}"${query.page > 1 ? ` on page ${query.page}` : ""}.`);
    // Without this the model blames its query, rewrites it and waits, over and over.
    const failed = failedEngines(data);
    if (failed) {
      lines.push(
        `Search engines that did not answer: ${failed}.`,
        "That is a problem on the search engines' side, not with the query: rewording it will not help. Try once more in a minute, or go on without this search.",
      );
    } else if (query.page === 1) {
      lines.push("The search engines answered and found nothing. Try fewer or different words.");
    }
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
  // SearXNG's "suggestions" are left out: they are the engines' autocompletions of the query
  // ("... key west fl"), which cost the model tokens and send it nowhere.
  const corrections = (data.corrections ?? []).map(text).filter(Boolean).slice(0, 3);
  if (corrections.length > 0) lines.push(`Did you mean: ${corrections.join("; ")}`);
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
