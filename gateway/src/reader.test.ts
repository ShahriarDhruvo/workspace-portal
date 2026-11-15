import { test } from "node:test";
import assert from "node:assert/strict";
import { createReaderBackend, formatPage, parseReadArguments, ReadError, withPageCache, type Page, type ReaderBackend } from "./reader.ts";

const page = (text: string, extra: Partial<Page> = {}): Page => ({ url: "https://docs.example/guide", kind: "html", title: "Guide", text, truncated: false, note: "", ...extra });
const never = new AbortController().signal;

test("the reader backend posts the URL and turns refusals into ReadErrors", async () => {
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  const answers: Array<() => Response> = [
    () => Response.json({ ok: true, url: "https://docs.example/final", kind: "html", title: "T", text: "body", truncated: false, note: "" }),
    () => Response.json({ ok: false, code: "blocked", message: "Only public internet sites can be read." }),
    () => Response.json({ ok: false, code: "timeout", message: "docs.example did not answer in time." }),
    () => new Response("oops", { status: 500 }),
  ];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
    return answers.shift()!();
  }) as typeof fetch;
  const backend = createReaderBackend({ baseUrl: "http://127.0.0.1:4003/", timeoutMs: 1000, fetchImpl });

  assert.deepEqual(await backend.read("https://docs.example/start", never), { url: "https://docs.example/final", kind: "html", title: "T", text: "body", truncated: false, note: "" });
  assert.deepEqual(requests[0], { url: "http://127.0.0.1:4003/read", method: "POST", body: { url: "https://docs.example/start" } });
  const fenced = createReaderBackend({ baseUrl: "http://127.0.0.1:4003", timeoutMs: 1000, fetchImpl: (async (_input: URL | RequestInfo, init?: RequestInit) => Response.json({ ok: false, code: "redirect", message: String(init?.body) })) as typeof fetch });
  await assert.rejects(
    fenced.read("https://github.com/x", never, { redirectHosts: ["github.com", "docs.rs"] }),
    (error: unknown) => error instanceof ReadError && !error.lasting && error.message === '{"url":"https://github.com/x","redirect_hosts":["github.com","docs.rs"]}',
  );
  await assert.rejects(backend.read("http://10.0.0.1/", never), (error: unknown) => error instanceof ReadError && error.lasting && /public internet/.test(error.message));
  await assert.rejects(backend.read("https://docs.example/slow", never), (error: unknown) => error instanceof ReadError && !error.lasting);
  await assert.rejects(backend.read("https://docs.example/x", never), /page reader failed/);

  const down = createReaderBackend({ baseUrl: "http://127.0.0.1:4003", timeoutMs: 1000, fetchImpl: (async () => Promise.reject(new Error("refused"))) as typeof fetch });
  await assert.rejects(down.read("https://docs.example/x", never), /did not answer/);

  // The reader cuts pages at 400,000 characters: an answer of many megabytes is not taken into memory.
  const huge = createReaderBackend({ baseUrl: "http://127.0.0.1:4003", timeoutMs: 1000, fetchImpl: (async () => Response.json({ ok: true, url: "https://docs.example/x", text: "x".repeat(5 * 1024 * 1024) })) as typeof fetch });
  await assert.rejects(huge.read("https://docs.example/x", never), /page reader failed/);
});

test("the page cache reuses a page, shares a download and remembers lasting refusals briefly", async () => {
  let clock = 0;
  const calls: string[] = [];
  let release: (page: Page) => void = () => undefined;
  const backend: ReaderBackend = {
    read(url) {
      calls.push(url);
      if (url.endsWith("/gone")) return Promise.reject(new ReadError("There is no page at that URL (HTTP 404).", true));
      if (url.endsWith("/flaky")) return Promise.reject(new ReadError("did not answer in time"));
      if (url.endsWith("/slow")) return new Promise((resolve) => (release = resolve));
      return Promise.resolve(page(`text of ${url}`));
    },
  };
  const cached = withPageCache(backend, { ttlMs: 1000, refusalTtlMs: 100, maxEntries: 2, now: () => clock });

  assert.equal((await cached.read("https://a.example/1", never)).text, "text of https://a.example/1");
  await cached.read("https://a.example/1", never);
  assert.equal(calls.length, 1, "served from the cache");
  clock = 1001;
  await cached.read("https://a.example/1", never);
  assert.equal(calls.length, 2, "expired");

  const both = Promise.all([cached.read("https://a.example/slow", never), cached.read("https://a.example/slow", never)]);
  await new Promise((resolve) => setImmediate(resolve));
  release(page("slow"));
  assert.deepEqual((await both).map((result) => result.text), ["slow", "slow"]);
  assert.equal(calls.filter((url) => url.endsWith("/slow")).length, 1, "one download for two readers");

  await assert.rejects(cached.read("https://a.example/gone", never), /HTTP 404/);
  await assert.rejects(cached.read("https://a.example/gone", never), /HTTP 404/);
  assert.equal(calls.filter((url) => url.endsWith("/gone")).length, 1, "a dead link is not fetched again right away");
  clock += 101;
  await assert.rejects(cached.read("https://a.example/gone", never), /HTTP 404/);
  assert.equal(calls.filter((url) => url.endsWith("/gone")).length, 2);
  await assert.rejects(cached.read("https://a.example/flaky", never));
  await assert.rejects(cached.read("https://a.example/flaky", never));
  assert.equal(calls.filter((url) => url.endsWith("/flaky")).length, 2, "a timeout is worth another try");

  // Two entries at most: reading two more pages pushes the oldest out.
  const before = calls.length;
  await cached.read("https://a.example/2", never);
  await cached.read("https://a.example/3", never);
  await cached.read("https://a.example/3", never);
  await cached.read("https://a.example/1", never);
  assert.equal(calls.length - before, 3);

  assert.equal(withPageCache(backend, { ttlMs: 0 }), backend, "0 turns the cache off");
});

test("the page cache keeps a fenced read apart from an unfenced one of the same URL", async () => {
  const fences: Array<readonly string[] | null> = [];
  const backend: ReaderBackend = {
    async read(url, _signal, options) {
      fences.push(options?.redirectHosts ?? null);
      // Unfenced, the reader followed a redirect off the site; fenced, it would have refused.
      if (options?.redirectHosts) throw new ReadError("That address redirects to another site (elsewhere.example), and the redirect was not followed.");
      return page("redirected content", { url: "https://elsewhere.example/landing" });
    },
  };
  const cached = withPageCache(backend, { ttlMs: 1000 });
  assert.equal((await cached.read("https://docs.example/go", never, { redirectHosts: null })).url, "https://elsewhere.example/landing");
  await assert.rejects(cached.read("https://docs.example/go", never, { redirectHosts: ["docs.example"] }), /redirect was not followed/);
  assert.equal((await cached.read("https://docs.example/go", never)).url, "https://elsewhere.example/landing");
  assert.deepEqual(fences, [null, ["docs.example"]], "the unfenced page was reused only for an unfenced read");
});

test("formatPage pages through long text at line breaks and says how to continue", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index).padStart(2, "0")} ${"x".repeat(40)}`);
  const long = page(lines.join("\n"));
  const first = formatPage(long, 0, 1000);
  assert.match(first, /^Title: Guide\nURL: https:\/\/docs\.example\/guide\n\nline 00 /);
  const hint = /\[Characters 0-(\d+) of (\d+)\. To continue, call read_page with the same url and start=(\d+)\.\]$/.exec(first);
  assert.ok(hint, first.slice(-200));
  assert.equal(hint[1], hint[3]);
  assert.equal(Number(hint[2]), long.text.length);
  const next = Number(hint[3]);
  assert.ok(next <= 1000 && next > 0);
  assert.equal(long.text[next - 1], "\n", "the part ends at a line break");
  assert.match(formatPage(long, next, 1000), /\n\nline \d\d /, "the next part starts with a whole line");

  // Walking the hints returns every line exactly once.
  let start = 0;
  let seen = "";
  for (let guard = 0; guard < 50; guard++) {
    const part = formatPage(long, start, 1000);
    seen += part.split("\n\n").slice(1, -1).join("\n\n") + "\n";
    const more = /start=(\d+)\.\]$/.exec(part);
    if (!more) {
      assert.match(part, /\[End of page\. Characters \d+-\d+ of \d+\.\]$/);
      break;
    }
    start = Number(more[1]);
  }
  assert.deepEqual(seen.trim().split("\n"), lines);

  assert.match(formatPage(page("short"), 0, 1000), /\n\nshort\n\n\[End of page, 5 characters\.\]$/);
  assert.match(formatPage(page("cut", { truncated: true }), 0, 1000), /was cut after 3 characters\.\]$/);
  assert.match(formatPage(page("short"), 99, 1000), /\[There is nothing at start=99: the page is 5 characters long\.\]$/);
  assert.match(formatPage(page("", { title: "" }), 0, 1000), /^URL: https:\/\/docs\.example\/guide\n\n\[The page has no text\.\]$/);
  assert.match(formatPage(page("x", { note: "Only the first 60 of 200 pages were read." }), 0, 1000), /\nNote: Only the first 60 of 200 pages were read\.\n\nx\n/);
});

test("parseReadArguments validates the url and start", () => {
  assert.deepEqual(parseReadArguments({ url: " https://docs.example/a " }), { url: "https://docs.example/a", start: 0 });
  assert.deepEqual(parseReadArguments({ url: "HTTP://docs.example/a", start: 20000 }), { url: "HTTP://docs.example/a", start: 20000 });
  for (const bad of [null, {}, { url: "" }, { url: "docs.example/a" }, { url: "file:///etc/passwd" }, { url: "https://x/" + "a".repeat(2000) }, { url: "https://x/", start: -1 }, { url: "https://x/", start: 1.5 }, { url: "https://x/", start: "0" }]) {
    assert.equal(typeof parseReadArguments(bad), "string", JSON.stringify(bad)?.slice(0, 60));
  }
});
