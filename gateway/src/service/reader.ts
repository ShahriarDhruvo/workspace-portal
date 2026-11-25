// The read_page tool: the gateway's side of the page reader. The fetching and parsing happen in the reader container
// (reader/), which is unprivileged and can only reach the public internet. The gateway decides whether a workspace
// may open a URL (url-policy.ts), asks the reader, keeps the answer for a while so paging through a long page costs
// one download, and hands the model one slice at a time.
import { parseJson, readBoundedText } from "@portal/core";
import { canonicalUrl, MAX_URL_CHARS } from "./url-policy.ts";

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

export interface ReaderBackend {
  /**
   * Reads one page; throws ReadError with a message meant for the model. `redirectHosts`: the only sites a redirect
   * may lead to, besides staying on its own host (for a URL the model may have put together itself); null: anywhere public.
   */
  read(url: string, signal: AbortSignal, options?: { redirectHosts: readonly string[] | null }): Promise<Page>;
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

/**
 * One request to a service that works for the workspaces (SearXNG, the reader), under its base URL and never
 * following a redirect. Null when it did not answer in time, or `signal` aborted first.
 */
export async function askService(service: { baseUrl: string; timeoutMs: number; fetchImpl?: typeof fetch }, path: string, init: RequestInit, signal: AbortSignal): Promise<Response | null> {
  const url = new URL(path, service.baseUrl.endsWith("/") ? service.baseUrl : `${service.baseUrl}/`);
  try {
    return await (service.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(service.timeoutMs)]) });
  } catch {
    return null;
  }
}

/** The reader cuts a page at 400,000 characters; an answer far beyond that is not one of its own. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** Reader answers that will not change by asking again soon. */
const LASTING_CODES = new Set(["bad_url", "blocked", "dns", "http", "tls", "unsupported", "empty", "too_large"]);

export function createReaderBackend(options: { baseUrl: string; timeoutMs: number; fetchImpl?: typeof fetch }): ReaderBackend {
  return {
    async read(url, signal, readOptions) {
      const fence = readOptions?.redirectHosts ?? null;
      const headers = { "content-type": "application/json", accept: "application/json" };
      const body = JSON.stringify(fence === null ? { url } : { url, redirect_hosts: fence });
      const response = await askService(options, "read", { method: "POST", headers, body }, signal);
      if (response === null) throw new ReadError("The page reader did not answer. Try again in a moment.");
      const data = parseJson((await readBoundedText(response, MAX_ANSWER_BYTES).catch(() => null)) ?? "");
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

/** Total characters of page text the cache keeps. */
const MAX_CACHED_CHARS = 8_000_000;

type CacheEntry = { expires: number; page: Page } | { expires: number; refusal: string };

/**
 * Wraps a reader with a small cache (`ttlMs`; 0 turns it off); concurrent reads of one URL share a download. A
 * lasting refusal is kept for `refusalTtlMs`, so an agent retrying a dead link does not hammer the site. A page read
 * with a redirect fence and the same page read without one are kept apart, so a fenced read is never answered with
 * what an unfenced one was redirected to. The caller's signal is not passed on: a download that others may be waiting
 * for is not cancelled by one of them leaving.
 */
export function withPageCache(backend: ReaderBackend, options: { ttlMs: number; refusalTtlMs?: number; maxEntries?: number; now?: () => number }): ReaderBackend {
  if (options.ttlMs <= 0) return backend;
  const { ttlMs, refusalTtlMs = 120_000, maxEntries = 64, now = Date.now } = options;
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
      if ((entries.size <= maxEntries && chars <= MAX_CACHED_CHARS) || oldest === key) break;
      drop(oldest);
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
        download = backend
          .read(url, new AbortController().signal, readOptions)
          .then(
            (page) => {
              store(key, { expires: now() + ttlMs, page });
              return page;
            },
            (error: unknown) => {
              if (error instanceof ReadError && error.lasting) store(key, { expires: now() + refusalTtlMs, refusal: error.message });
              throw error;
            },
          )
          .finally(() => pending.delete(key));
        pending.set(key, download);
      }
      return await download;
    },
  };
}

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
