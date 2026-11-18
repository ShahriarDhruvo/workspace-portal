// Release notes (GitHub markdown) as a few safe blocks: headings, list items and paragraphs, with bold and code
// spans. Links keep their text and lose their address; images, HTML tags and everything else are reduced to plain
// text. Nothing is ever rendered as HTML.

export interface NoteSpan {
  text: string;
  bold?: boolean;
  code?: boolean;
}

export type NoteBlock =
  { kind: "heading"; spans: NoteSpan[] } | { kind: "item"; spans: NoteSpan[] } | { kind: "paragraph"; spans: NoteSpan[] };

/** Strips what never shows: images (their alt text stays), link targets, HTML tags, stray emphasis marks. */
function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|$|[.,;:!?)])/g, "$1$2");
}

/** Splits a line into plain, **bold** and `code` spans. */
export function noteSpans(line: string): NoteSpan[] {
  const spans: NoteSpan[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index;
    if (at > last) spans.push({ text: plain(line.slice(last, at)) });
    if (match[1] !== undefined) spans.push({ text: match[1], code: true });
    else spans.push({ text: plain(match[2] ?? match[3] ?? ""), bold: true });
    last = at + match[0].length;
  }
  if (last < line.length) spans.push({ text: plain(line.slice(last)) });
  return spans.filter((span) => span.text.length > 0);
}

/**
 * The notes as blocks, at most `maxBlocks` of them (long changelogs are cut; the full notes are a link away). A
 * first heading that only repeats `version` (release-please's "## [0.34.0](…) (2026-11-10)") is left out: the
 * notes are shown under the version already.
 */
export function parseReleaseNotes(markdown: string, maxBlocks = 60, version?: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", spans: noteSpans(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^(?:[*+-]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line) || line.startsWith("```")) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", spans: noteSpans(heading[1] ?? "") });
    } else if (item) {
      flush();
      blocks.push({ kind: "item", spans: noteSpans(item[1] ?? "") });
    } else {
      paragraph.push(line.replace(/^>\s?/, ""));
    }
  }
  flush();
  const shown = blocks.filter((block) => block.spans.length > 0);
  const first = shown[0];
  const text =
    first?.spans
      .map((span) => span.text)
      .join("")
      .trim() ?? "";
  if (version && first?.kind === "heading" && (text === version || text.startsWith(`${version} `) || text === `v${version}`)) shown.shift();
  return shown.slice(0, maxBlocks);
}
