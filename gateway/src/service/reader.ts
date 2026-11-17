// The read_page tool: the gateway's side of the page reader.
//
// The fetching and parsing happen in the reader container (reader/), which is unprivileged and can
// only reach the public internet. The gateway decides whether a workspace may open a URL
// (url-policy.ts), asks the reader, keeps the answer for a while so paging through a long page
// costs one download, and hands the model one slice at a time.
import { canonicalUrl, MAX_URL_CHARS } from "./url-policy.ts";

export { MAX_URL_CHARS };

/** One page as the reader returns it. */
export interface Page {
  /** Where the content came from, after redirects. */
  url: string;
  kind: string;
  title: string;
  text: string;
  /** The page was cut at the reader's size limit. */
  truncated: boolean;
  note: string;
}

export interface ReadOptions {
  /**
   * The only sites a redirect may lead to, besides staying on its own host; null: anywhere public.
   * Set for a URL the model may have put together itself (see url-policy.ts).
   */
  redirectHosts: readonly string[] | null;
}

export interface ReaderBackend {
  /** Reads one page; throws ReadError with a message meant for the model. */
  read(url: string, signal: AbortSignal, options?: ReadOptions): Promise<Page>;
}

export class ReadError extends Error {
  /** Refusals that will repeat (a missing page, a blocked address) are worth remembering briefly. */
  readonly lasting: boolean;

  constructor(message: string, lasting = false) {
    super(message);
    this.name = "ReadError";
    this.lasting = lasting;
  }
}

export interface ReaderOptions {
  /** Base URL of the reader container. */
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** The reader cuts a page at 400,000 characters; an answer far beyond that is not one of its own. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** The body as text, or an error once it is longer than `limit` bytes. */
async function bodyText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("the reader's answer is too long");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reader answers that will not change by asking again soon. */
const LASTING_CODES = new Set(["bad_url", "blocked", "dns", "http", "tls", "unsupported", "empty", "too_large"]);

export function createReaderBackend(options: ReaderOptions): ReaderBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL("read", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  return {
    async read(url, signal, readOptions) {
      const fence = readOptions?.redirectHosts ?? null;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(fence === null ? { url } : { url, redirect_hosts: fence }),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
        });
      } catch {
        throw new ReadError("The page reader did not answer. Try again in a moment.");
      }
      let data: unknown;
      try {
        data = JSON.parse(await bodyText(response, MAX_ANSWER_BYTES));
      } catch {
        data = null;
      }
      if (!response.ok || data === null || typeof data !== "object") {
        throw new ReadError("The page reader failed on that page. Try another source.");
      }
      const answer = data as Record<string, unknown>;
      if (answer.ok !== true) {
        const message = typeof answer.message === "string" && answer.message !== "" ? answer.message : "The page could not be read.";
        throw new ReadError(message, typeof answer.code === "string" && LASTING_CODES.has(answer.code));
      }
      return {
        url: typeof answer.url === "string" ? answer.url : url,
        kind: typeof answer.kind === "string" ? answer.kind : "text",
        title: typeof answer.title === "string" ? answer.title : "",
        text: typeof answer.text === "string" ? answer.text : "",
        truncated: answer.truncated === true,
        note: typeof answer.note === "string" ? answer.note : "",
      };
    },
  };
}

export interface PageCacheOptions {
  /** How long a page is kept; 0 turns the cache off. */
  ttlMs: number;
  /** How long a lasting refusal is kept, so an agent retrying a dead link does not hammer the site. */
  refusalTtlMs?: number;
  maxEntries?: number;
  /** Total characters of page text kept. */
  maxChars?: number;
  now?: () => number;
}

type CacheEntry = { expires: number; page: Page } | { expires: number; refusal: string };

/**
 * Wraps a reader with a small cache; concurrent reads of one URL share a download. A page read
 * with a redirect fence and the same page read without one are kept apart, so a fenced read is
 * never answered with what an unfenced one was redirected to. The caller's signal is not passed
 * on: a download that others may be waiting for is not cancelled by one of them leaving.
 */
export function withPageCache(backend: ReaderBackend, options: PageCacheOptions): ReaderBackend {
  if (options.ttlMs <= 0) return backend;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 64;
  const maxChars = options.maxChars ?? 8_000_000;
  const refusalTtlMs = options.refusalTtlMs ?? 120_000;
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<Page>>();
  let chars = 0;

  const drop = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    if ("page" in entry) chars -= entry.page.text.length;
    entries.delete(key);
  };
  const store = (key: string, entry: CacheEntry): void => {
    drop(key);
    entries.set(key, entry);
    if ("page" in entry) chars += entry.page.text.length;
    for (const oldest of entries.keys()) {
      if (entries.size <= maxEntries && chars <= maxChars) break;
      if (oldest !== key) drop(oldest);
      else break;
    }
  };

  return {
    async read(url, _signal, readOptions) {
      const key = `${readOptions?.redirectHosts ? "fenced" : "open"} ${url}`;
      const cached = entries.get(key);
      if (cached) {
        if (cached.expires > now()) {
          if ("refusal" in cached) throw new ReadError(cached.refusal, true);
          return cached.page;
        }
        drop(key);
      }
      let download = pending.get(key);
      if (!download) {
        download = backend.read(url, new AbortController().signal, readOptions).then(
          (page) => {
            store(key, { expires: now() + options.ttlMs, page });
            return page;
          },
          (error: unknown) => {
            if (error instanceof ReadError && error.lasting) store(key, { expires: now() + refusalTtlMs, refusal: error.message });
            throw error;
          },
        );
        pending.set(key, download);
        const forget = (): void => void pending.delete(key);
        download.then(forget, forget);
      }
      return await download;
    },
  };
}

// ------------------------------------------------------------------ the tool

export function readPageTool(pageChars: number) {
  return {
    name: "read_page",
    title: "Read a web page",
    description:
      "Open a web page or PDF and return its text as markdown, without menus and ads. Use it on a URL from web_search " +
      "results, from a page you already read, or from the conversation. Long pages come in parts of about " +
      `${pageChars.toLocaleString("en-US")} characters: when the answer ends with a "start=" hint, call again with that start ` +
      "to continue. Pages that only appear with JavaScript, and sites that refuse automated readers, cannot be read.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full http(s) URL of the page.", minLength: 1, maxLength: MAX_URL_CHARS },
        start: { type: "integer", description: "Character offset to continue from, as given at the end of the previous part. Default 0.", minimum: 0 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  } as const;
}

export interface ReadRequest {
  url: string;
  start: number;
}

/** Validates tool arguments; returns an error message for the model on bad input. */
export function parseReadArguments(args: unknown): ReadRequest | string {
  if (args === null || typeof args !== "object") return "Provide the url of the page.";
  const { url, start } = args as Record<string, unknown>;
  if (typeof url !== "string" || url.trim() === "") return "Provide the url of the page.";
  if (url.length > MAX_URL_CHARS) return `Keep the URL under ${MAX_URL_CHARS} characters.`;
  if (!/^https?:\/\//i.test(url.trim())) return "The url must start with http:// or https://.";
  if (canonicalUrl(url) === null) return "That is not a valid http(s) URL.";
  if (start !== undefined && (!Number.isSafeInteger(start) || (start as number) < 0)) return "start must be a whole number, 0 or more.";
  return { url: url.trim(), start: (start as number | undefined) ?? 0 };
}

/** How far before the limit a part may end early to stop at a line break. */
const BREAK_WINDOW = 2000;

/** One part of a page for the model: a short header, the slice, and how to get the next one. */
export function formatPage(page: Page, start: number, pageChars: number): string {
  const total = page.text.length;
  const header = [`URL: ${page.url}`];
  if (page.title) header.unshift(`Title: ${page.title}`);
  if (page.note) header.push(`Note: ${page.note}`);
  if (start >= total) {
    return [...header, "", total === 0 ? "[The page has no text.]" : `[There is nothing at start=${start}: the page is ${total} characters long.]`].join("\n");
  }
  let end = Math.min(total, start + pageChars);
  if (end < total) {
    const lineBreak = page.text.lastIndexOf("\n", end);
    if (lineBreak > start && lineBreak >= end - BREAK_WINDOW) end = lineBreak + 1;
  }
  const lines = [...header, "", page.text.slice(start, end).trimEnd(), ""];
  if (end < total) {
    lines.push(`[Characters ${start}-${end} of ${total}. To continue, call read_page with the same url and start=${end}.]`);
  } else if (page.truncated) {
    lines.push(`[End of what was read: the page is longer than the reader's limit and was cut after ${total} characters.]`);
  } else {
    lines.push(start === 0 ? `[End of page, ${total} characters.]` : `[End of page. Characters ${start}-${total} of ${total}.]`);
  }
  return lines.join("\n");
}
