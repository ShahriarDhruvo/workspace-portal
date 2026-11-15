// HTML to markdown for the page reader: one process per page, HTML on stdin, JSON on stdout.
//
//   node extract.mjs <url> < page.html   ->   {"title": "...", "markdown": "...", "codeBlocks": 12}
//
// Defuddle finds the main content and converts it. It was chosen for agents that read
// documentation: of the extractors compared it is the one that keeps code blocks as code. Four
// things it gets wrong on documentation sites are corrected here, before and after it runs:
//
//   1. It deletes same-page cross-references (Sphinx's <a class="reference internal" href="#...">)
//      together with their text, which leaves holes in sentences.
//   2. It removes elements whose id contains words such as "search" or "share". On headings and
//      sections an id is an anchor made from the title, so "Module search path" would disappear.
//   3. Its markdown step can re-indent, re-flow or drop blank lines in code. Every <pre> is saved
//      first and put back verbatim afterwards, with the language of the block when the page names it.
//   4. It drops the page's main heading.
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";

// Nothing here needs the network; a library that tries is told no.
globalThis.fetch = async () => {
  throw new Error("the page reader's converter has no network access");
};

const DEFUDDLE_OPTIONS = { markdown: true, useAsync: false, removeContentPatterns: false };

const LANGUAGE_CLASS = /(?:language-|lang-|highlight-source-|highlight-|brush:\s*|sp-)([a-z0-9+#-]+)/i;
const NOT_A_LANGUAGE = new Set(["default", "none", "text", "plaintext", "cm", "pre", "code", "stack", "pristine", "placeholder", "wrapper", "layout", "editor", "tabs", "tab"]);

/** Fix 1: a same-page link with real text stays (footnote markers such as [1] or ↩ may go). */
function keepCrossReferences(document) {
  for (const link of document.querySelectorAll('a[href^="#"][class*="ref" i]')) {
    const text = (link.textContent || "").trim();
    if (text && !/^[[(]?\d+[\])]?$/.test(text) && !/^[↑↩^¶#*]+$/.test(text)) link.removeAttribute("class");
  }
}

/** Fix 2: ids on sections, headings and definition terms are anchors, not hints about layout. */
function dropAnchorIds(document) {
  for (const element of document.querySelectorAll("section[id], div.section[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], dt[id]")) {
    element.removeAttribute("id");
  }
}

/** Fix 3, before: the text of every <pre>, in document order, with the language its classes name. */
function collectCode(document) {
  const blocks = [];
  for (const pre of document.querySelectorAll("pre")) {
    const copy = pre.cloneNode(true);
    for (const br of Array.from(copy.querySelectorAll("br"))) br.parentNode.replaceChild(document.createTextNode("\n"), br);
    // Highlighters that put each line in a <div> rely on CSS for the line break.
    for (const line of Array.from(copy.querySelectorAll("div"))) if (!/\n$/.test(line.textContent)) line.appendChild(document.createTextNode("\n"));
    for (const button of Array.from(copy.querySelectorAll("button"))) button.remove();
    const text = copy.textContent.replace(/\r/g, "").replace(/^\n+|\s+$/g, "");
    const key = text.replace(/\s+/g, "");
    if (!key) continue;
    const classes = [pre, pre.firstElementChild, pre.parentNode, pre.parentNode?.parentNode].map((node) => node?.getAttribute?.("class") || "").join(" ");
    const match = classes.match(LANGUAGE_CLASS);
    let language = match ? match[1].toLowerCase() : /\brust\b/.test(classes) ? "rust" : "";
    if (NOT_A_LANGUAGE.has(language)) language = "";
    blocks.push({ text, key, language });
  }
  return blocks;
}

/**
 * Fix 3, after: each fenced block in the markdown whose text (ignoring whitespace) is that of a
 * saved <pre> gets the saved text back. A block that matches nothing is replaced only when it sits
 * between two matched blocks and exactly one saved <pre> is left between the same two.
 */
function restoreCode(markdown, saved) {
  const byKey = new Map();
  saved.forEach((block, index) => {
    if (!byKey.has(block.key)) byKey.set(block.key, []);
    byKey.get(block.key).push(index);
  });
  const lines = markdown.split("\n");
  const fences = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^([ \t>]*)(`{3,})([^`]*)$/.exec(lines[i]);
    if (!open) continue;
    const close = new RegExp(`^[ \\t>]*\`{${open[2].length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    if (j >= lines.length) break;
    const body = lines.slice(i + 1, j).map((line) => (line.startsWith(open[1]) ? line.slice(open[1].length) : line));
    fences.push({ open: i, close: j, indent: open[1], ticks: open[2], info: open[3].trim(), key: body.join("\n").replace(/\s+/g, ""), source: -1 });
    i = j;
  }

  const used = new Set();
  let last = -1;
  for (const fence of fences) {
    const candidates = (byKey.get(fence.key) || []).filter((index) => !used.has(index));
    const pick = candidates.find((index) => index > last) ?? candidates[0];
    if (pick === undefined) continue;
    fence.source = pick;
    used.add(pick);
    last = Math.max(last, pick);
  }
  for (let k = 0; k < fences.length; k++) {
    if (fences[k].source >= 0) continue;
    const before = k > 0 ? fences[k - 1].source : -1;
    const after = k + 1 < fences.length ? fences[k + 1].source : saved.length;
    if ((k > 0 && before < 0) || (k + 1 < fences.length && after < 0)) continue;
    const between = [];
    for (let index = before + 1; index < after; index++) if (!used.has(index)) between.push(index);
    if (between.length !== 1) continue;
    fences[k].source = between[0];
    used.add(between[0]);
  }

  for (const fence of fences.reverse()) {
    if (fence.source < 0) continue;
    const block = saved[fence.source];
    const longestRun = (block.text.match(/`+/g) || []).reduce((longest, run) => Math.max(longest, run.length), 0);
    const ticks = "`".repeat(Math.max(fence.ticks.length, longestRun + 1));
    const body = block.text.split("\n").map((line) => (line ? fence.indent + line : fence.indent.trimEnd()));
    lines.splice(fence.open, fence.close - fence.open + 1, fence.indent + ticks + (fence.info || block.language), ...body, fence.indent + ticks);
  }
  return { markdown: lines.join("\n"), codeBlocks: fences.length };
}

async function convert(html, url) {
  const { document } = parseHTML(html);
  keepCrossReferences(document);
  dropAnchorIds(document);
  const saved = collectCode(document);
  const result = await Defuddle(document, url, DEFUDDLE_OPTIONS);
  const title = (result.title || "").replace(/\s+/g, " ").trim();
  let { markdown, codeBlocks } = restoreCode((result.content || "").trim(), saved);
  // Fix 4.
  if (markdown && title && !/^#\s/.test(markdown)) markdown = `# ${title}\n\n${markdown}`;
  return { title, markdown, codeBlocks };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const url = process.argv[2] || "";
try {
  const answer = await convert(await readStdin(), url);
  process.stdout.write(JSON.stringify(answer));
} catch (error) {
  process.stderr.write(`extract: ${error?.message || error}\n`);
  process.exitCode = 1;
}
