import { test } from "node:test";
import assert from "node:assert/strict";
import { recorder } from "../../test/fakes.ts";
import { searchBackend } from "../compose.ts";
import type { Config } from "../config.ts";
import { createExaBackend, EXA_URL, parseExaResults } from "./exa-search.ts";
import type { SearchBackend, SearchQuery } from "./search-mcp.ts";

const search = (query: string, more: Partial<SearchQuery> = {}): SearchQuery => ({ query, page: 1, timeRange: null, language: null, ...more });
const never = new AbortController().signal;

/** Exa's answer for a search, as its tool gives it: one text, a block per result. */
const exaText = (results: Array<{ title: string; url: string; published?: string; excerpt: string }>): string =>
  results.map((r) => `Title: ${r.title}\nURL: ${r.url}\nPublished: ${r.published ?? "N/A"}\nAuthor: N/A\nHighlights:\n${r.excerpt}`).join("\n\n---\n\n");
/** The event stream Exa's MCP server answers a tool call with. */
const exaStream = (text: string, more: Record<string, unknown> = {}): Response =>
  new Response(`event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }], ...more }, jsonrpc: "2.0", id: 1 })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const fedora = exaText([{ title: "Fedora 45", url: "https://fedoraproject.org/45", excerpt: "Fedora 45 is out." }]);

/** Exa answering with `answers` in turn (the last one again after that), SearXNG as a stub, and a clock. */
function setup(answers: Array<Response | (() => Response | Promise<Response>)>, options: { cacheMs?: number; timeoutMs?: number } = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const searxng: SearchQuery[] = [];
  const failures: Array<{ reason: string; pauseMs: number }> = [];
  const clock = { now: 1_000_000 };
  const fallback: SearchBackend = { search: async (query) => (searxng.push(query), `searxng: ${query.query}`) };
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    const answer = answers[Math.min(requests.length, answers.length) - 1]!;
    return typeof answer === "function" ? answer() : answer.clone();
  }) as typeof fetch;
  const backend = createExaBackend({ fallback, timeoutMs: options.timeoutMs ?? 1000, cacheMs: options.cacheMs, onFailure: (failure) => failures.push(failure), fetchImpl, now: () => clock.now });
  return { backend, requests, searxng, failures, clock };
}

test("a search goes to Exa as one tool call, with nothing but the query, and comes back in the form of SearXNG's results", async () => {
  const text = exaText([
    { title: "List the ruleset\n      -\n    nftables wiki", url: "https://wiki.nftables.org/list", excerpt: "# Listing\n\n`nft -a list ruleset` prints   the handles.\n...\nSee also https://wiki.nftables.org/handles" },
    { title: "Fedora 45", url: "https://fedoraproject.org/45", published: "2026-10-28T00:00:00.000Z", excerpt: "x".repeat(900) },
  ]);
  const { backend, requests, searxng, failures } = setup([exaStream(text)]);
  const out = await backend.search(search("nft list handles"), never);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, EXA_URL);
  assert.equal(EXA_URL, "https://mcp.exa.ai/mcp");
  assert.equal(requests[0]!.init.method, "POST");
  assert.equal(requests[0]!.init.redirect, "error");
  const headers = new Headers(requests[0]!.init.headers);
  assert.deepEqual([...headers.keys()].sort(), ["accept", "content-type", "user-agent"], "no key, no cookie, nothing of the portal's");
  assert.equal(headers.get("accept"), "application/json, text/event-stream", "Exa refuses a client that takes only one of them");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "web_search_exa", arguments: { query: "nft list handles", objective: "nft list handles", numResults: 10 } },
  });

  assert.equal(
    out,
    [
      'Results for "nft list handles" (page 1):',
      "",
      "1. List the ruleset - nftables wiki",
      "   https://wiki.nftables.org/list",
      "   # Listing `nft -a list ruleset` prints the handles. ... See also https://wiki.nftables.org/handles",
      "",
      "2. Fedora 45",
      "   https://fedoraproject.org/45",
      `   ${"x".repeat(499)}…`,
      "   Published: 2026-10-28T00:00:00.000Z",
    ].join("\n"),
  );
  assert.deepEqual([searxng, failures], [[], []]);
});

test("a plain JSON answer is read as well as an event stream, and only a stream's last message counts", async () => {
  const json = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: fedora }] } }), { status: 200, headers: { "content-type": "application/json" } });
  assert.match(await setup([json]).backend.search(search("fedora"), never), /1\. Fedora 45\n {3}https:\/\/fedoraproject\.org\/45\n {3}Fedora 45 is out\./);

  const message = (text: string): string => `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } })}\r\n\r\n`;
  const stream = new Response(`: ping\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n${message(fedora)}`, { status: 200 });
  assert.match(await setup([stream]).backend.search(search("fedora"), never), /1\. Fedora 45/);
});

test("what Exa's tool cannot be asked goes to SearXNG: a later page, a time range, a language", async () => {
  const { backend, requests, searxng } = setup([exaStream(fedora)]);
  for (const more of [{ page: 2 }, { timeRange: "week" as const }, { language: "de" }]) {
    assert.equal(await backend.search(search("fedora", more), never), "searxng: fedora");
  }
  assert.equal(requests.length, 0, "Exa was not asked");
  assert.deepEqual(searxng.map((query) => [query.page, query.timeRange, query.language]), [[2, null, null], [1, "week", null], [1, null, "de"]]);
});

test("when Exa refuses or fails, SearXNG answers that search, and Exa is left alone for ten minutes", async () => {
  const error = (status: number, headers: Record<string, string> = {}) => new Response("no", { status, headers });
  const cases: Array<{ name: string; answer: Response | (() => Response | Promise<Response>); reason: RegExp; pauseMs?: number }> = [
    { name: "over its limit", answer: error(429), reason: /takes no more searches for now \(HTTP 429\)/ },
    { name: "over its limit, with a time", answer: error(429, { "retry-after": "90" }), reason: /HTTP 429/, pauseMs: 90_000 },
    { name: "over its limit, with a time too long", answer: error(429, { "retry-after": "86400" }), reason: /HTTP 429/, pauseMs: 3_600_000 },
    { name: "a server error", answer: error(503), reason: /^HTTP 503$/ },
    { name: "no connection", answer: () => Promise.reject(new TypeError("fetch failed")), reason: /fetch failed/ },
    { name: "a fetch that throws", answer: () => { throw new TypeError("bad address"); }, reason: /bad address/ },
    { name: "a tool error", answer: exaStream("Search error: upstream timed out", { isError: true }), reason: /answered with an error: Search error: upstream timed out/ },
    { name: "an RPC error", answer: new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Unknown tool"}}\n\n', { status: 200 }), reason: /answered with an error: Unknown tool/ },
    { name: "no results it can read", answer: exaStream("No search results found."), reason: /holds no result in the form this reads/ },
    { name: "not an answer at all", answer: new Response("<html>hello</html>", { status: 200 }), reason: /answered with an error: no message/ },
    { name: "an answer far too long", answer: () => exaStream("x".repeat(1024 * 1024)), reason: /longer than a search's/ },
  ];
  for (const { name, answer, reason, pauseMs = 600_000 } of cases) {
    const { backend, requests, searxng, failures, clock } = setup([answer, exaStream(fedora)]);
    assert.equal(await backend.search(search("fedora"), never), "searxng: fedora", name);
    assert.equal(failures.length, 1, name);
    assert.match(failures[0]!.reason, reason, name);
    assert.equal(failures[0]!.pauseMs, pauseMs, name);

    clock.now += pauseMs - 1;
    assert.equal(await backend.search(search("kernel"), never), "searxng: kernel", `${name}: still left alone`);
    assert.equal(requests.length, 1, `${name}: Exa was asked once`);
    clock.now += 1;
    assert.match(await backend.search(search("kernel"), never), /1\. Fedora 45/, `${name}: asked again after the pause`);
    assert.deepEqual([requests.length, searxng.length, failures.length], [2, 2, 1], name);
  }
});

test("an Exa that does not answer in time is given up on, and a workspace that hangs up is not held against Exa", async () => {
  // As fetch does with a server that never answers: it ends when its signal does.
  const hangs = ({ signal }: RequestInit): Promise<Response> =>
    new Promise((_, reject) => (signal!.aborted ? reject(signal!.reason) : signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })));
  const requests: RequestInit[] = [];
  const failures: Array<{ reason: string; pauseMs: number }> = [];
  const fallback: SearchBackend = { search: async (query) => `searxng: ${query.query}` };
  const fetchImpl = ((_: URL | RequestInfo, init?: RequestInit) => (requests.push(init!), hangs(init!))) as typeof fetch;
  const slow = createExaBackend({ fallback, timeoutMs: 30, onFailure: (failure) => failures.push(failure), fetchImpl });
  assert.equal(await slow.search(search("fedora"), never), "searxng: fedora");
  assert.deepEqual(failures, [{ reason: "no answer within 0.03 s", pauseMs: 600_000 }]);

  failures.length = 0;
  const backend = createExaBackend({ fallback, timeoutMs: 5_000, onFailure: (failure) => failures.push(failure), fetchImpl });
  const gone = new AbortController();
  const pending = backend.search(search("fedora"), gone.signal);
  gone.abort();
  assert.equal(await pending, "searxng: fedora");
  assert.deepEqual(failures, [], "nothing is known about Exa");
  await backend.search(search("kernel"), AbortSignal.abort());
  assert.equal(requests.length, 3, "and Exa is asked the next search");
});

test("the same search is answered from memory for a while; what SearXNG answered for Exa is not kept here", async () => {
  const kernel = exaText([{ title: "Kernel", url: "https://kernel.org", excerpt: "7.3 is out." }]);
  const { backend, requests, searxng, clock } = setup([exaStream(fedora), exaStream(kernel), new Response("", { status: 500 }), exaStream(kernel)], { cacheMs: 1000 });
  const first = await backend.search(search("Fedora"), never);
  assert.equal(await backend.search(search("fedora"), never), first, "whatever the case of the letters");
  assert.equal(requests.length, 1);
  clock.now += 1000;
  assert.match(await backend.search(search("fedora"), never), /1\. Kernel/, "asked again once the answer is old");
  assert.equal(requests.length, 2);

  assert.equal(await backend.search(search("nftables"), never), "searxng: nftables");
  clock.now += 600_000;
  assert.match(await backend.search(search("nftables"), never), /1\. Kernel/, "Exa is asked once it is back");
  assert.deepEqual([requests.length, searxng.length], [4, 1]);

  const uncached = setup([exaStream(fedora)]);
  await uncached.backend.search(search("fedora"), never);
  await uncached.backend.search(search("fedora"), never);
  assert.equal(uncached.requests.length, 2, "no cache unless one is asked for");
});

test("parseExaResults finds each result's lines, whatever its excerpts hold", () => {
  const text = exaText([
    { title: "A", url: "https://a.example/1", excerpt: "first\n\n---\n\nnot a result: a line of the page\n\nTitle: nor is this\nmore text" },
    { title: "B\nsecond line", url: "https://b.example/2?x=1#y", published: "2026-01-02", excerpt: "" },
    { title: "C", url: "ftp://c.example/file", excerpt: "not a web address" },
    { title: "D", url: "HTTP://d.example", excerpt: "last\n" },
  ]);
  assert.deepEqual(parseExaResults(text), [
    { title: "A", url: "https://a.example/1", content: "first\n\n---\n\nnot a result: a line of the page\n\nTitle: nor is this\nmore text", publishedDate: "" },
    { title: "B\nsecond line", url: "https://b.example/2?x=1#y", content: "", publishedDate: "2026-01-02" },
    { title: "D", url: "HTTP://d.example", content: "last\n", publishedDate: "" },
  ]);
  assert.deepEqual(parseExaResults(""), []);
  assert.deepEqual(parseExaResults("Title: only a title\nURL: https://x.example\n"), [], "a result has all its lines");
});

test("the gateway asks Exa only when EXA_SEARCH says so, and the tool's description says where a search goes", () => {
  const settings: Config["search"] = { url: "http://127.0.0.1:9", authorization: "", timeoutMs: 1000, maxConcurrentPerUser: 2, fallbackEngines: [], fallbackBelow: 3, cacheMs: 0, exa: false };
  const { log } = recorder(() => null);
  assert.equal(searchBackend(settings, log).through, undefined, "SearXNG alone, which the description names by itself");
  assert.equal(searchBackend({ ...settings, exa: true }, log).through, "Exa, or the organization's own SearXNG instance when Exa does not answer");
});
