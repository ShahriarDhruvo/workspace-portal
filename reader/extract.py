"""HTML to markdown for the page reader: Defuddle, in a Node process of its own for every page (extract.mjs),
so that a page which makes the converter loop or grow is killed alone. When the converter fails, or throws away
nearly all of a page that plainly has text, the page's text is returned as it is, with a note that says so.
"""
from __future__ import annotations

import codecs
import json
import os
import re
import resource
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

NODE = "node"
SCRIPT = Path(__file__).with_name("extract.mjs")
CONVERT_SECONDS = 25
NODE_HEAP_MB = 256
# A conversion this short, from a page whose plain text is LOST_FACTOR times longer, lost the page.
SHORT_CHARS = 200
LOST_FACTOR = 10

UNCLEANED = "This page could not be reduced to its main content, so menus and other clutter are included."
LITTLE_TEXT = "The page has very little text. If more was expected, it is probably filled in by JavaScript, which this reader does not run."


def decode(body: bytes, charset: str = "", meta: bool = False) -> str:
    """Bytes to text: a byte-order mark, the charset the server declared, with `meta` an HTML page's own <meta>, then UTF-8."""
    # UTF-32 before UTF-16: its little-endian mark begins with UTF-16's.
    for mark, name in ((codecs.BOM_UTF8, "utf-8-sig"), (codecs.BOM_UTF32_LE, "utf-32"), (codecs.BOM_UTF32_BE, "utf-32"), (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16")):
        if body.startswith(mark):
            return body.decode(name, errors="replace")
    declared = [charset]
    found = meta and re.search(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)""", body[:4096], re.I)
    if found:
        declared.append(found[1].decode("ascii", errors="ignore"))
    for name in declared:
        if not name:
            continue
        try:
            return body.decode(name)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", errors="replace")


def _unlimited_heap() -> None:
    # The request process caps its own heap (reader.py); V8 manages its own with --max-old-space-size.
    _, hard = resource.getrlimit(resource.RLIMIT_DATA)
    resource.setrlimit(resource.RLIMIT_DATA, (hard, hard))


def convert(html: str, url: str, timeout: float = CONVERT_SECONDS) -> dict | None:
    """Runs the converter; None when it failed, timed out or answered nonsense."""
    try:
        done = subprocess.run(
            [NODE, f"--max-old-space-size={NODE_HEAP_MB}", str(SCRIPT), url],
            input=html.encode("utf-8", errors="replace"),
            capture_output=True,
            timeout=timeout,
            preexec_fn=_unlimited_heap,
            env={"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "NODE_COMPILE_CACHE": os.environ.get("NODE_COMPILE_CACHE", "")},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    try:
        answer = json.loads(done.stdout)
    except ValueError:
        return None
    if not isinstance(answer, dict) or not isinstance(answer.get("markdown"), str):
        return None
    return answer


class _PlainText(HTMLParser):
    """The text of a page as simple markdown, without deciding what the main content is."""

    SKIP = {"script", "style", "noscript", "template", "svg", "iframe", "head", "select", "button", "form", "canvas", "object"}
    BLOCK = {"p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol", "table", "blockquote", "figure", "dl", "dt", "dd", "details", "summary", "hr"}
    HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.out: list[str] = []
        self.skip = 0
        self.pre = 0
        self.pre_start = 0
        self.href: list[str | None] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self.skip += 1
        if self.skip:
            return
        if tag == "pre":
            self.pre += 1
            if self.pre == 1:
                self.out.append("\n\n```\n")
                self.pre_start = len(self.out)
        elif self.pre:
            if tag == "br":
                self.out.append("\n")
        elif tag in self.HEADINGS:
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag in ("tr", "br"):
            self.out.append("\n")
        elif tag in ("td", "th"):
            self.out.append(" | ")
        elif tag == "a":
            href = dict(attrs).get("href") or ""
            if href and not href.startswith(("#", "javascript:", "mailto:", "data:")):
                self.href.append(urljoin(self.base, href))
                self.out.append("[")
            else:
                self.href.append(None)
        elif tag in self.BLOCK:
            self.out.append("\n\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag == "pre" and self.pre:
            self.pre -= 1
            if self.pre == 0:
                code = "".join(self.out[self.pre_start :]).strip("\n").rstrip()
                self.out[self.pre_start :] = [code, "\n```\n\n"]
        elif self.pre:
            return
        elif tag == "a" and self.href:
            href = self.href.pop()
            if href:
                self.out.append(f"]({href})")
        elif tag in self.HEADINGS:
            self.out.append("\n\n")
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        self.out.append(data if self.pre else re.sub(r"\s+", " ", data))


def plain_text(html: str, url: str) -> str:
    """Everything a page says, in order, as simple markdown."""
    parser = _PlainText(url)
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # html.parser gives up on very little, but a broken page must not break the answer
        pass
    kept: list[str] = []
    fenced = False
    for line in "".join(parser.out).split("\n"):
        if line.strip() == "```":
            fenced = not fenced
            kept.append("```")
            continue
        if fenced:
            kept.append(line.rstrip())
            continue
        line = re.sub(r"[ \t\xa0]+", " ", line).strip()
        line = re.sub(r"\[\s*\]\([^)]*\)", "", line).strip()  # links around images, with no words
        if line.startswith("#"):
            line = line.rstrip("¶ ")  # the "link to this heading" mark
        if line or (kept and kept[-1]):
            kept.append(line)
    return "\n".join(kept).strip()


def html_to_markdown(body: bytes, url: str, charset: str = "") -> tuple[str, str]:
    """(markdown, note) for an HTML page; ("", "") when it has no text to give."""
    html = decode(body, charset, meta=True)
    answer = convert(html, url)
    markdown = answer["markdown"].strip() if answer else ""
    if answer and len(markdown) >= SHORT_CHARS:
        return markdown, ""
    everything = plain_text(html, url)
    if answer is None or len(everything) > max(SHORT_CHARS, len(markdown)) * LOST_FACTOR:
        return (everything, UNCLEANED if everything else "")
    return markdown or everything, (LITTLE_TEXT if markdown or everything else "")
