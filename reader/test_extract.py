"""Tests for turning pages into text: the HTML converter, its fallback, and PDFs.

Run:  python3 -m unittest -v test_extract
The converter tests need Node with this directory's node_modules, and the PDF test needs pypdfium2.
Where one is missing the test is skipped, except in the image build (READER_TESTS_REQUIRE_ALL=1),
where a missing piece is a failure.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

import extract
import reader

HERE = Path(__file__).parent
DOCS = (HERE / "testdata" / "docs.html").read_bytes()
URL = "https://docs.example.org/3/tutorial/modules.html"
REQUIRE_ALL = os.environ.get("READER_TESTS_REQUIRE_ALL") == "1"

HAVE_CONVERTER = shutil.which(extract.NODE) is not None and (HERE / "node_modules" / "defuddle").is_dir()
try:
    import pypdfium2  # noqa: F401

    HAVE_PDF = True
except ImportError:
    HAVE_PDF = False


def needs(available: bool, what: str):
    return unittest.skipUnless(available or REQUIRE_ALL, f"{what} is not installed here")


def tiny_pdf(lines: list[str], pages: int = 1) -> bytes:
    """A valid PDF with `pages` pages, each showing `lines` in Helvetica."""
    content = b"BT /F1 14 Tf 20 120 Td 16 TL " + b" ".join(b"(" + line.encode("latin-1") + b") Tj T*" for line in lines) + b" ET"
    kids = " ".join(f"{4 + 2 * index} 0 R" for index in range(pages))
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode(), b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    for index in range(pages):
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents {5 + 2 * index} 0 R /Resources << /Font << /F1 3 0 R >> >> >>".encode())
        objects.append(b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


class Decoding(unittest.TestCase):
    def test_charset_comes_from_the_server_then_the_page_then_utf8(self):
        self.assertEqual(extract.decode("<p>grüße</p>".encode("latin-1"), "iso-8859-1", meta=True), "<p>grüße</p>")
        self.assertEqual(extract.decode('<meta charset="windows-1251"><p>привет</p>'.encode("cp1251"), meta=True), '<meta charset="windows-1251"><p>привет</p>')
        self.assertEqual(extract.decode('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><p>日本</p>'.encode("shift_jis"), meta=True), '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><p>日本</p>')
        self.assertEqual(extract.decode("<p>grüße</p>".encode(), meta=True), "<p>grüße</p>")
        self.assertEqual(extract.decode(b"\xef\xbb\xbf<p>bom</p>", "iso-8859-1", meta=True), "<p>bom</p>")
        self.assertEqual(extract.decode("<p>grüße</p>".encode(), "no-such-charset", meta=True), "<p>grüße</p>")
        self.assertEqual(extract.decode(b"<p>bad \xff byte</p>", "utf-8", meta=True), "<p>bad � byte</p>")


class PlainText(unittest.TestCase):
    def test_everything_readable_is_kept_in_order(self):
        text = extract.plain_text(extract.decode(DOCS, meta=True), URL)
        self.assertNotIn("SCRIPT-TEXT-MUST-NOT-APPEAR", text)
        self.assertNotIn("STYLE-TEXT-MUST-NOT-APPEAR", text)
        self.assertIn("- [SIDEBAR-INSTALL-LINK](https://docs.example.org/install.html)", text, "no judgement about what is a menu")
        self.assertIn("# Importing modules", text)
        self.assertIn("## Module search path", text)
        self.assertIn("[language reference](https://docs.example.org/3/reference/import.html)", text)
        self.assertIn("```\nimport sys\n\ndef show():\n    for entry in sys.path:\n        print(entry)\n\n\nshow()\n```", text)
        self.assertIn("```\nbuild:\n\tcc -O2 -o app main.c\n\tstrip app\n```", text)
        self.assertIn("| Name | Meaning\n| sys.modules | Modules already loaded\n| sys.path | Where to look for new ones", text)
        self.assertIn("- Clearing the table forces a fresh import.\n- Entries may be replaced while a program runs.", text)
        self.assertIn("## Module search path\n\nWhen a module", text, "headings lose their link mark")
        self.assertLess(text.index("Module search path"), text.index("The module cache"))
        self.assertNotIn("\n\n\n\n", text.replace("\n\n\nshow()", ""))

    def test_broken_markup_still_gives_text(self):
        self.assertEqual(extract.plain_text("<p>one<p>two</div></span><b>three", URL), "one\n\ntwo\nthree")
        self.assertEqual(extract.plain_text("", URL), "")
        self.assertEqual(extract.plain_text("<a href='javascript:x()'>click</a> <a href='#top'>up</a> <a href='/a b'>go</a>", URL), "click up [go](https://docs.example.org/a b)")


class Fallbacks(unittest.TestCase):
    """html_to_markdown decides between the converter's answer and the plain text of the page."""

    def run_with(self, converted: dict | None, html: bytes = DOCS) -> tuple[str, str]:
        with mock.patch.object(extract, "convert", return_value=converted) as convert:
            answer = extract.html_to_markdown(html, URL, "utf-8")
            self.assertEqual(convert.call_args.args[1], URL)
        return answer

    def test_a_good_conversion_is_returned_as_it_is(self):
        markdown = "# Title\n\n" + "A sentence of real content. " * 20
        self.assertEqual(self.run_with({"markdown": markdown + "\n\n"}), (markdown.strip(), ""))

    def test_a_failed_conversion_falls_back_to_the_whole_text(self):
        text, note = self.run_with(None)
        self.assertIn("## Module search path", text)
        self.assertIn("SIDEBAR-INSTALL-LINK", text)
        self.assertEqual(note, extract.UNCLEANED)

    def test_a_conversion_that_lost_the_page_falls_back_too(self):
        long_page = b"<html><body><div class='x'>" + b"<p>Real paragraph of the page, number one of many.</p>" * 80 + b"</div></body></html>"
        text, note = self.run_with({"markdown": "Cookie notice"}, long_page)
        self.assertIn("Real paragraph of the page", text)
        self.assertEqual(note, extract.UNCLEANED)

    def test_a_short_page_is_returned_with_a_note(self):
        short = b"<html><body><p>It works!</p></body></html>"
        self.assertEqual(self.run_with({"markdown": "It works!"}, short), ("It works!", extract.LITTLE_TEXT))
        self.assertEqual(self.run_with({"markdown": ""}, short), ("It works!", extract.LITTLE_TEXT))

    def test_a_page_without_text_gives_nothing(self):
        shell = b"<html><head><script>boot()</script></head><body><div id='root'></div><noscript>Enable JavaScript.</noscript></body></html>"
        self.assertEqual(self.run_with({"markdown": ""}, shell), ("", ""))
        self.assertEqual(self.run_with(None, shell), ("", ""))

    def test_a_converter_that_hangs_or_breaks_counts_as_failed(self):
        for failure in [subprocess.TimeoutExpired("node", 25), FileNotFoundError("node"), OSError("fork failed")]:
            with mock.patch.object(subprocess, "run", side_effect=failure):
                self.assertIsNone(extract.convert("<p>x</p>", URL))
        for returncode, stdout in [(1, b""), (0, b"not json"), (0, b"[]"), (0, b'{"markdown": 7}'), (134, b'{"markdown": "x"}')]:
            with mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], returncode, stdout, b"")):
                self.assertIsNone(extract.convert("<p>x</p>", URL), (returncode, stdout))


@needs(HAVE_CONVERTER, "Node with defuddle")
class Converter(unittest.TestCase):
    """The real converter on a documentation page of the kind agents read most."""

    @classmethod
    def setUpClass(cls):
        cls.markdown, cls.note = extract.html_to_markdown(DOCS, URL)

    def test_the_main_content_is_kept_and_the_rest_dropped(self):
        self.assertEqual(self.note, "")
        for clutter in ["SIDEBAR-INSTALL-LINK", "SIDEBAR-CHANGELOG-LINK", "FOOTER-COPYRIGHT-LINE", "SCRIPT-TEXT-MUST-NOT-APPEAR", "STYLE-TEXT-MUST-NOT-APPEAR", "¶"]:
            self.assertNotIn(clutter, self.markdown)
        self.assertTrue(self.markdown.startswith("# Importing modules"), self.markdown[:80])
        self.assertIn("## The module cache", self.markdown)
        self.assertIn("| `sys.modules` | Modules already loaded |", self.markdown)
        self.assertIn("- Clearing the table forces a fresh import.", self.markdown)

    def test_code_comes_back_exactly_with_its_language(self):
        self.assertIn("```python\nimport sys\n\ndef show():\n    for entry in sys.path:\n        print(entry)\n\n\nshow()\n```", self.markdown)
        self.assertIn("```\nbuild:\n\tcc -O2 -o app main.c\n\tstrip app\n```", self.markdown, "tabs are kept")

    def test_text_the_library_would_cut_is_kept(self):
        self.assertIn("described in [the module cache](", self.markdown, "a same-page cross-reference keeps its words")
        self.assertIn("## Module search path", self.markdown, "a section whose id contains 'search'")
        self.assertIn("whose id contains the word search and must be kept", self.markdown)

    def test_links_are_absolute(self):
        self.assertIn("[language reference](https://docs.example.org/3/reference/import.html)", self.markdown)

    def test_hostile_input_ends_its_own_process(self):
        self.assertIsNone(extract.convert("<p>" * 200_000 + "deep", URL, timeout=0.05), "a conversion past its time limit is killed")
        page = "<html><head><title>T</title><script>while(true){}</script></head><body><article><script>for(;;){}</script><p>Scripts in a page are text, they never run.</p>" + "<p>More text for the page.</p>" * 20 + "</article></body></html>"
        answer = extract.convert(page, URL)
        self.assertIsNotNone(answer)
        self.assertIn("More text for the page.", answer["markdown"])

    def test_reader_puts_it_together(self):
        page = reader.Fetched(URL, 200, "text/html", "utf-8", DOCS, False)
        result = reader.read(URL, fetcher=lambda url, redirect_hosts=None: page)
        self.assertEqual((result["ok"], result["kind"], result["title"], result["truncated"], result["note"]), (True, "html", "Importing modules — Example 3.2 documentation", False, ""))
        self.assertIn("```python\nimport sys", result["text"])


@needs(HAVE_PDF, "pypdfium2")
class Pdf(unittest.TestCase):
    def test_text_is_read_page_by_page(self):
        text, pages, total = reader.extract_pdf(tiny_pdf(["Hello PDF reader", "Second line"], pages=3))
        self.assertEqual((pages, total), (3, 3))
        self.assertTrue(text.startswith("## Page 1\n\nHello PDF reader"), text[:80])
        self.assertIn("Second line", text)
        self.assertIn("## Page 3\n\nHello PDF reader", text)

    def test_long_files_are_cut_at_the_page_limit(self):
        page = reader.Fetched("https://example.com/paper.pdf", 200, "application/pdf", "", tiny_pdf(["Hello"], pages=5), False)
        with mock.patch.object(reader, "MAX_PDF_PAGES", 2):
            result = reader.read(page.url, fetcher=lambda url, redirect_hosts=None: page)
        self.assertEqual((result["kind"], result["note"]), ("pdf", "Only the first 2 of 5 pages were read."))
        self.assertNotIn("## Page 3", result["text"])

    def test_what_is_not_a_readable_pdf_is_refused(self):
        with self.assertRaises(reader.Refused) as caught:
            reader.extract_pdf(b"%PDF-1.7\nthis is not really a pdf")
        self.assertEqual(caught.exception.code, "unsupported")
        empty = reader.Fetched("https://example.com/scan.pdf", 200, "application/pdf", "", tiny_pdf([]), False)
        with self.assertRaises(reader.Refused) as caught:
            reader.read(empty.url, fetcher=lambda url, redirect_hosts=None: empty)
        self.assertEqual(caught.exception.code, "empty")


if __name__ == "__main__":
    unittest.main()
