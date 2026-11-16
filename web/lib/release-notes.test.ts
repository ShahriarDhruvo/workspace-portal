import { test } from "node:test";
import assert from "node:assert/strict";
import { noteSpans, parseReleaseNotes } from "./release-notes.ts";

test("release notes become headings, items and paragraphs; links keep their text, HTML is dropped", () => {
  const blocks = parseReleaseNotes(
    "## [0.34.0](https://github.com/x/y/compare/v0.33.0...v0.34.0) (2026-11-10)\n\n### ⚠ BREAKING CHANGES\n\n* **audio:** drop libsndfile ([abc123](https://github.com/x/y/commit/abc123))\n- second <script>alert(1)</script>item\n\nA paragraph\nover two lines with `code`.\n",
  );
  assert.deepEqual(blocks, [
    { kind: "heading", spans: [{ text: "0.34.0 (2026-11-10)" }] },
    { kind: "heading", spans: [{ text: "⚠ BREAKING CHANGES" }] },
    { kind: "item", spans: [{ text: "audio:", bold: true }, { text: " drop libsndfile (abc123)" }] },
    { kind: "item", spans: [{ text: "second alert(1)item" }] },
    { kind: "paragraph", spans: [{ text: "A paragraph over two lines with " }, { text: "code", code: true }, { text: "." }] },
  ]);
});

test("a first heading that repeats the version is left out", () => {
  const notes = "## [0.34.0](https://x/compare) (2026-11-10)\n\n* one";
  assert.deepEqual(parseReleaseNotes(notes, 60, "0.34.0"), [{ kind: "item", spans: [{ text: "one" }] }]);
  assert.equal(parseReleaseNotes(notes, 60, "0.33.0").length, 2);
  assert.equal(parseReleaseNotes("### Features\n* x", 60, "0.34.0")[0]?.kind, "heading");
});

test("spans: bold and code, images reduced to their alt text, long notes cut", () => {
  assert.deepEqual(noteSpans("![logo](x.png) __big__"), [{ text: "logo " }, { text: "big", bold: true }]);
  assert.equal(parseReleaseNotes(Array.from({ length: 100 }, (_, i) => `* item ${i}`).join("\n"), 10).length, 10);
  assert.deepEqual(parseReleaseNotes(""), []);
});
