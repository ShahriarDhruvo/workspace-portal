// Exa in front of SearXNG for web_search, when EXA_SEARCH is on. Exa is a search service made for AI agents; its
// hosted MCP server answers without an account or a key, at a limit Exa does not publish. A search goes to Exa when
// Exa can answer it as asked: the first page, with no time range and no language, which its tool does not take. Every
// other search goes to SearXNG, and so does one that Exa refuses, fails or answers with nothing this reads; after
// that Exa is left alone for a while. The model sees the same tool and the same form of answer either way.
//
// Each query Exa gets leaves the server for a company, from the server's address. That is what EXA_SEARCH turns on:
// without it a search only ever goes to SearXNG.
import { failureReason, readBoundedText } from "../lib/bounded-body.ts";
import { field, parseJson } from "../lib/json.ts";
import { createAnswerCache, formatResults, MAX_RESULTS, type SearchBackend } from "./search-mcp.ts";

/** Exa's hosted MCP server. It takes a tool call by itself: no handshake and no session come first. */
export const EXA_URL = "https://mcp.exa.ai/mcp";
const EXA_TOOL = "web_search_exa";
/** Ten results with their excerpts come to about 30 kB. */
const MAX_ANSWER_BYTES = 1024 * 1024;
/** How long Exa is left alone after it refused or failed, unless it names a time itself (Retry-After). */
const PAUSE_MS = 10 * 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

export interface ExaOptions {
  /** Answers what Exa is not asked and what it does not answer. */
  fallback: SearchBackend;
  timeoutMs: number;
  /** How long an answer is reused for the same search; 0 turns the cache off. */
  cacheMs?: number;
  /** Told when Exa did not answer a search: why, and how long it is left alone. */
  onFailure?: (failure: { reason: string; pauseMs: number }) => void;
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ExaResult {
  title: string;
  url: string;
  content: string;
  publishedDate: string;
}

class ExaFailure extends Error {
  readonly pauseMs: number;
  constructor(reason: string, pauseMs = PAUSE_MS) {
    super(reason);
    this.pauseMs = pauseMs;
  }
}

export function createExaBackend(options: ExaOptions): SearchBackend {
  const { fallback, timeoutMs, url = EXA_URL, fetchImpl = fetch, now = Date.now } = options;
  const cache = createAnswerCache(options.cacheMs ?? 0, now);
  let pausedUntil = 0;

  async function ask(query: string, signal: AbortSignal): Promise<ExaResult[]> {
    // Exa's tool wants the goal of the search beside the query; the model gave one text, which is both.
    const call = { name: EXA_TOOL, arguments: { query, objective: query, numResults: MAX_RESULTS } };
    let response: Response;
    let body: string | null;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        // Exa refuses a client that does not take both forms of answer; it sends an event stream.
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "workspace-portal-search/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      body = response.ok ? await readBoundedText(response, MAX_ANSWER_BYTES) : null;
    } catch (error) {
      throw new ExaFailure(failureReason(error, timeoutMs));
    }
    if (response.status === 429) throw new ExaFailure("it takes no more searches for now (HTTP 429)", retryAfterMs(response.headers.get("retry-after")));
    if (!response.ok) throw new ExaFailure(`HTTP ${response.status}`);
    if (body === null) throw new ExaFailure("its answer is longer than a search's");
    const message = rpcMessage(body);
    const result = field(message, "result");
    const content = field(result, "content");
    const texts = Array.isArray(content) ? content.map((item) => field(item, "text")).filter((text) => typeof text === "string") : [];
    if (!Array.isArray(content) || field(result, "isError") === true) {
      throw new ExaFailure(`it answered with an error: ${describe(field(field(message, "error"), "message") ?? texts[0])}`);
    }
    const results = parseExaResults(texts.join("\n"));
    if (results.length === 0) throw new ExaFailure("its answer holds no result in the form this reads");
    return results;
  }

  return {
    through: "Exa, or the organization's own SearXNG instance when Exa does not answer",
    async search(query, signal) {
      const asksExa = query.page === 1 && query.timeRange === null && query.language === null;
      if (!asksExa || now() < pausedUntil) return fallback.search(query, signal);
      const cached = cache.get(query);
      if (cached !== null) return cached;
      let results: ExaResult[];
      try {
        results = await ask(query.query, signal);
      } catch (error) {
        if (!(error instanceof ExaFailure)) throw error;
        // A workspace that hung up says nothing about Exa.
        if (!signal.aborted) {
          pausedUntil = now() + error.pauseMs;
          options.onFailure?.({ reason: error.message, pauseMs: error.pauseMs });
        }
        return fallback.search(query, signal);
      }
      const answer = formatResults(query, { results });
      cache.set(query, answer);
      return answer;
    },
  };
}

/** The JSON-RPC message of an MCP answer: the body itself, or the last message of an event stream. */
function rpcMessage(body: string): unknown {
  const whole = parseJson(body);
  if (whole !== null) return whole;
  let message: unknown = null;
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    const parsed = data === "" ? null : parseJson(data);
    if (field(parsed, "result") !== undefined || field(parsed, "error") !== undefined) message = parsed;
  }
  return message;
}

/**
 * One result of Exa's answer starts with these lines, and its excerpts follow up to the next result. A title may
 * run over a few lines.
 */
const RESULT_HEAD = /(?:^|\n)Title: ([^\n]*(?:\n[^\n]*){0,4}?)\nURL: (\S+)\nPublished: ([^\n]*)\nAuthor: [^\n]*\nHighlights:\n/g;

/** The results of the text Exa's search tool answers with, in SearXNG's form. */
export function parseExaResults(text: string): ExaResult[] {
  const heads = [...text.matchAll(RESULT_HEAD)];
  return heads
    .map((head, index) => ({
      title: head[1]!,
      url: head[2]!,
      // Without the line that parts it from the next result.
      content: text.slice(head.index + head[0].length, heads[index + 1]?.index ?? text.length).replace(/\n+---\s*$/, ""),
      publishedDate: head[3] === "N/A" ? "" : head[3]!,
    }))
    .filter((result) => /^https?:\/\//i.test(result.url));
}

/** Retry-After as Exa may send it, in seconds; without a usable one, the usual pause. */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_PAUSE_MS) : PAUSE_MS;
}

const describe = (value: unknown): string => (typeof value === "string" && value.trim() !== "" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : "no message");
