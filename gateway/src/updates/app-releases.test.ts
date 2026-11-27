import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppStatus } from "@portal/core";
import { appTagVersion, byNewestAppVersion, githubAppReleases, registryAppReleases, withInstalled } from "./app-releases.ts";
import type { GitHubRelease } from "./github-releases.ts";

const release = (tag: string, prerelease = false): GitHubRelease => ({
  tag,
  prerelease,
  notes: { title: tag, url: `https://github.com/o/r/releases/tag/${tag}`, publishedAt: 0, body: "", breaking: false },
});

test("versions sort newest first: release numbers as numbers, semver by precedence, the rest after", () => {
  assert.deepEqual(["99", "277", "1000", "276"].sort(byNewestAppVersion), ["1000", "277", "276", "99"]);
  assert.deepEqual(["2.0.0-beta", "3.0.0-beta", "1.5.1", "3.0.0"].sort(byNewestAppVersion), ["3.0.0", "3.0.0-beta", "2.0.0-beta", "1.5.1"]);
});

test("a tag's version is the pattern's first group, when hostd could install it", () => {
  assert.equal(appTagVersion(/^v([0-9]+)$/, "v277"), "277");
  assert.equal(appTagVersion(/^v([0-9]+)$/, "277"), null);
  assert.equal(appTagVersion(/^v(.+)$/, "v3.0.0-beta"), "3.0.0-beta");
  assert.equal(appTagVersion(/^v(.+)$/, "v../../etc"), null, "not a directory name");
});

test("GitHub releases: prereleases only when the app takes them, the newest five, the first latest", () => {
  const tags = [release("v3.0.0-beta", true), release("v2.0.0-beta", true), release("v1.5.1"), release("v1.5.0"), release("v1.4.3"), release("v1.4.2"), release("v1.4.1")];
  assert.deepEqual(
    githubAppReleases(tags, /^v(.+)$/, true).map((r) => [r.version, r.latest]),
    [
      ["3.0.0-beta", true],
      ["2.0.0-beta", false],
      ["1.5.1", false],
      ["1.5.0", false],
      ["1.4.3", false],
    ],
  );
  assert.deepEqual(
    githubAppReleases(tags, /^v(.+)$/, false).map((r) => r.version),
    ["1.5.1", "1.5.0", "1.4.3", "1.4.2", "1.4.1"],
  );
});

test("registry tags: per version its newest tag", () => {
  const pattern = /^rocm[0-9.]+-torch[0-9.]+-vllm([0-9]+\.[0-9]+\.[0-9]+)$/;
  const releases = registryAppReleases(["rocm10.0.0-torch2.11.0-vllm0.33.0", "rocm7.9.0-torch2.10.0-vllm0.33.0", "rocm10.0.0-torch2.11.0-vllm0.32.0", "latest", "20261102-152517"], pattern);
  assert.deepEqual(
    releases.map((r) => [r.version, r.tag, r.latest]),
    [
      ["0.33.0", "rocm10.0.0-torch2.11.0-vllm0.33.0", true],
      ["0.32.0", "rocm10.0.0-torch2.11.0-vllm0.32.0", false],
    ],
  );
});

test("the card lists the releases and every installed version, with notes by version", () => {
  const app = { versions: [{ version: "270", image: null, createdAt: 0, sizeBytes: null, current: true, previous: false }] } as unknown as AppStatus;
  const listed = withInstalled([{ version: "277", tag: null, latest: true }], app, new Map([["270", release("v270").notes]]));
  assert.deepEqual(
    listed.map((r) => [r.version, r.latest, r.notes?.title ?? null]),
    [
      ["277", true, null],
      ["270", false, "v270"],
    ],
  );
});
