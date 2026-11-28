import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeFetch } from "../../test/fakes.ts";
import { createGitHubReleases, GitHubError, hasBreakingChanges, tagVersion } from "./github-releases.ts";

test("hasBreakingChanges: a breaking-changes section with something in it, a BREAKING CHANGE line, a type!: entry", () => {
  const breaking = [
    // release-please (Gufo)
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
  assert.equal(tagVersion("v2.4.1", "@opencode/cli"), "2.4.1");
  assert.equal(tagVersion("process-daemon-v0.6.0", "@opencode/cli"), null);
});

test("list: anonymous, drafts left out, notes cut when long, only github.com links", async () => {
  const { fetch, calls } = fakeFetch({
    "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100": () =>
      Response.json([
        { tag_name: "dsh-v0.2.2-rc.3", name: "", html_url: "javascript:alert(1)", published_at: "2026-11-13T07:56:55Z", body: "x".repeat(20_000), prerelease: true },
        { tag_name: "dsh-v0.2.2-rc.2", draft: true, body: "draft" },
        { tag_name: "dsh-v0.2.2-rc.1", name: "dsh v0.2.2-rc.1", html_url: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1", published_at: null, body: "- Breaking change: x", prerelease: true },
        { name: "no tag" },
      ]),
  });
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
  assert.equal(calls[0]!.auth, null, "anonymous");
});

test("list: GitHub's refusals and odd repositories are a GitHubError", async () => {
  const fails = (repo: string, answer: () => Response, message: string | RegExp): Promise<void> =>
    assert.rejects(
      createGitHubReleases(fakeFetch({ [`https://api.github.com/repos/${repo}/releases?per_page=100`]: answer }).fetch).list(repo),
      (error: unknown) => error instanceof GitHubError && (typeof message === "string" ? error.message === message : message.test(error.message)),
    );
  const thrown = (error: Error) => (): Response => {
    throw error;
  };
  const repo = "QwenLM/qwen-code";
  await fails(repo, () => new Response("rate limited", { status: 403 }), "GitHub answered 403 for QwenLM/qwen-code's releases");
  await fails(repo, thrown(new TypeError("fetch failed")), "GitHub is unreachable (fetch failed)");
  await fails(repo, thrown(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "GitHub is unreachable (no answer within 10 s)");
  await fails(repo, () => new Response("x".repeat(32 * 1024 * 1024 + 1)), "GitHub's list of QwenLM/qwen-code's releases is too large");
  const uncancellable = new ReadableStream({ pull: (stream) => stream.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)), cancel: () => Promise.reject(new Error("cancel failed")) });
  await fails(repo, () => new Response(uncancellable), "GitHub's list of QwenLM/qwen-code's releases is too large");
  await fails(repo, () => new Response("<html>"), /^GitHub is unreachable \(Unexpected token .* is not valid JSON\)$/);
  await fails("../etc", () => Response.json([]), "../etc is not a GitHub repository (owner/name)");
});

test("commits: a branch's newest in GitHub's order; the message's first line is the title, the rest the body", async () => {
  const [newest, second, third] = ["d5615110e3ae7d27f270eafe5556d669b2069971", "a27da44d54d3146c06e4f4adcb96b6cb8c293b09", "aa67cca4cc3c1c557a936efb5b875319c988f800"] as const;
  const { fetch, calls } = fakeFetch({
    "https://api.github.com/repos/inclusionAI/Ming-Image/commits?sha=release%2F0.2&per_page=3": () =>
      Response.json([
        { sha: newest, html_url: "javascript:alert(1)", commit: { message: "docs: add DiT parameter counts to the model overview", author: { date: "2026-11-20T08:00:00Z" }, committer: { date: "2026-11-26T12:07:32Z" } } },
        { sha: second, commit: { message: "feat: one sampler for every size\r\n\r\nThe 2048 path had its own.\n\nBREAKING CHANGE: `--sampler` is gone\n", committer: { date: "2026-11-26T10:43:47Z" } } },
        { sha: third, commit: { message: "", committer: null } },
      ]),
  });
  const commits = await createGitHubReleases(fetch).commits("inclusionAI/Ming-Image", "release/0.2", 3);
  const url = (id: string) => `https://github.com/inclusionAI/Ming-Image/commit/${id}`;
  assert.deepEqual(commits, [
    { id: newest, notes: { title: "docs: add DiT parameter counts to the model overview", url: url(newest), publishedAt: Date.parse("2026-11-26T12:07:32Z"), body: "", breaking: false } },
    {
      id: second,
      notes: {
        title: "feat: one sampler for every size",
        url: url(second),
        publishedAt: Date.parse("2026-11-26T10:43:47Z"),
        body: "The 2048 path had its own.\n\nBREAKING CHANGE: `--sampler` is gone",
        breaking: true,
      },
    },
    { id: third, notes: { title: third, url: url(third), publishedAt: null, body: "", breaking: false } },
  ]);
  assert.equal(calls[0]!.auth, null, "anonymous");
});

test("commits: GitHub's refusals, and an answer whose order can't be relied on, are a GitHubError", async () => {
  const repo = "inclusionAI/Ming-Image";
  const fails = (answer: () => Response, message: string): Promise<void> =>
    assert.rejects(
      createGitHubReleases(fakeFetch({ [`https://api.github.com/repos/${repo}/commits?sha=main&per_page=5`]: answer }).fetch).commits(repo, "main", 5),
      (error: unknown) => error instanceof GitHubError && error.message === message,
    );
  await fails(() => Response.json({ message: "Not Found" }, { status: 404 }), "GitHub answered 404 for inclusionAI/Ming-Image's commits on main");
  await fails(() => new Response("x".repeat(32 * 1024 * 1024 + 1)), "GitHub's list of inclusionAI/Ming-Image's commits on main is too large");
  await fails(() => Response.json({ message: "Moved" }), "GitHub's answer for inclusionAI/Ming-Image's commits on main is not a list");
  await fails(() => Response.json([{ sha: "d561511", commit: { message: "x" } }]), "GitHub's list of inclusionAI/Ming-Image's commits on main has an entry without a commit id");
  await fails(() => Response.json([null]), "GitHub's list of inclusionAI/Ming-Image's commits on main has an entry without a commit id");
  await assert.rejects(createGitHubReleases(fakeFetch({}).fetch).commits("../etc", "main", 5), { name: "GitHubError", message: "../etc is not a GitHub repository (owner/name)" });
});
