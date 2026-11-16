import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubReleases, GitHubError, hasBreakingChanges, tagVersion } from "./github-releases.ts";

test("hasBreakingChanges: a breaking-changes section with something in it, a BREAKING CHANGE line, a type!: entry", () => {
  const breaking = [
    // release-please (the LLM engine)
    "## [0.34.0](https://x)\n\n### ⚠ BREAKING CHANGES\n\n* **audio:** decode in Rust\n\n### Features\n\n* x",
    // Qwen Code 0.27.2
    "## Highlights\n\n- x\n\n## Breaking Changes\n\n- fix(deps)!: upgrade dependencies ([#16452](https://x))\n\n## Complete Change List",
    // DeepSeek Harness alphas
    "## What's Changed\n- Breaking change: remove runtime invariant plugins. by @someone",
    "* **Breaking change:** The Session persistence API is now owned by `SessionHandle`s",
    // A Conventional Commits footer, an entry marked breaking
    "feat: x\n\nBREAKING CHANGE: the config moved",
    "### Features\n\n* feat(managed-agent)!: retire cwd submissions by @x",
  ];
  for (const notes of breaking) assert.equal(hasBreakingChanges(notes), true, notes);
  const fine = [
    // Qwen Code's notes always have the section
    "<!-- qwen-release-notes:v1 -->\n\n## Highlights\n\n- x\n\n## Breaking Changes\n\nNo known breaking changes.\n\n## Complete Change List\n\n### Features\n\n- feat(x): y",
    "### Breaking changes\n\n_None._\n\n### Fixes\n\n- fix",
    "### Breaking changes\n\nN/A",
    "There are no breaking changes: upgrade freely.",
    "fix!: a line that is no list entry",
    "",
  ];
  for (const notes of fine) assert.equal(hasBreakingChanges(notes), false, notes);
});

test("tagVersion: v1.2.3 and 1.2.3, or the package's own prefixed tags; another product's tags are none", () => {
  assert.equal(tagVersion("v0.27.4", "@qwen-code/qwen-code"), "0.27.4");
  assert.equal(tagVersion("0.27.4", "@qwen-code/qwen-code"), "0.27.4");
  assert.equal(tagVersion("v0.27.3-nightly.20261115.6e3b2dcc19", "@qwen-code/qwen-code"), "0.27.3-nightly.20261115.6e3b2dcc19");
  assert.equal(tagVersion("desktop-v0.27.4", "@qwen-code/qwen-code"), null);
  assert.equal(tagVersion("sdk-typescript-v0.1.34", "@qwen-code/qwen-code"), null);
  assert.equal(tagVersion("dsh-v0.2.2-rc.1", "@deepseek-ai/dsh"), "0.2.2-rc.1");
  assert.equal(tagVersion("dsh@0.2.2", "@deepseek-ai/dsh"), "0.2.2");
  assert.equal(tagVersion("@deepseek-ai/dsh@0.2.2", "@deepseek-ai/dsh"), "0.2.2");
  assert.equal(tagVersion("nightly", "@deepseek-ai/dsh"), null);
});

/** A fetch that answers one URL, recording the requests' headers. */
function fakeFetch(url: string, answer: () => Response) {
  const requests: Headers[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Headers(init?.headers));
    return String(input) === url ? answer() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchStub, requests };
}

test("list: anonymous, drafts left out, notes cut when long, only github.com links", async () => {
  const { fetch, requests } = fakeFetch("https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100", () =>
    Response.json([
      { tag_name: "dsh-v0.2.2-rc.3", name: "", html_url: "javascript:alert(1)", published_at: "2026-11-13T07:56:55Z", body: "x".repeat(20_000), prerelease: true },
      { tag_name: "dsh-v0.2.2-rc.2", draft: true, body: "draft" },
      { tag_name: "dsh-v0.2.2-rc.1", name: "dsh v0.2.2-rc.1", html_url: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1", published_at: null, body: "- Breaking change: x", prerelease: true },
      { name: "no tag" },
    ]),
  );
  const releases = await createGitHubReleases(fetch).list("deepseek-ai/deepseek-harness");
  assert.deepEqual(
    releases.map((release) => release.tag),
    ["dsh-v0.2.2-rc.3", "dsh-v0.2.2-rc.1"],
  );
  const [long, rc1] = releases as [(typeof releases)[number], (typeof releases)[number]];
  assert.equal(long.notes.title, "dsh-v0.2.2-rc.3");
  assert.equal(long.notes.url, "https://github.com/deepseek-ai/deepseek-harness/releases");
  assert.equal(long.notes.publishedAt, Date.parse("2026-11-13T07:56:55Z"));
  assert.ok(long.notes.body.length < 12_100 && long.notes.body.endsWith("…"));
  assert.deepEqual(rc1.notes, {
    title: "dsh v0.2.2-rc.1",
    url: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1",
    publishedAt: null,
    body: "- Breaking change: x",
    breaking: true,
  });
  assert.equal(requests[0]!.get("authorization"), null, "anonymous");
});

test("list: GitHub's refusals and odd repositories are a GitHubError", async () => {
  const { fetch } = fakeFetch("https://api.github.com/repos/QwenLM/qwen-code/releases?per_page=100", () => new Response("rate limited", { status: 403 }));
  await assert.rejects(createGitHubReleases(fetch).list("QwenLM/qwen-code"), (error: unknown) => error instanceof GitHubError && /answered 403/.test(error.message));
  await assert.rejects(createGitHubReleases(fetch).list("../etc"), GitHubError);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(createGitHubReleases(down).list("QwenLM/qwen-code"), /GitHub is unreachable \(fetch failed\)/);
});
