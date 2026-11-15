"""Tests for the page reader. No network: names resolve and sites answer from tables in this file.

Run:  python3 -m unittest -v test_reader     (the image build runs them too)
"""
from __future__ import annotations

import atexit
import gzip
import http.client
import ipaddress
import json
import os
import shutil
import socket
import socketserver
import tempfile
import threading
import time
import unittest
import urllib.request
import zlib
from unittest import mock

import reader
from reader import Fetched, Refused, Target, fetch, is_public, kind_of, parse_target, resolve_public

PUBLIC = "93.184.215.14"
reader.SLOT_DIR = tempfile.mkdtemp(prefix="reader-test-")  # this run's own places to work in
atexit.register(shutil.rmtree, reader.SLOT_DIR, ignore_errors=True)


class Reply:
    """What a site sends back: enough of http.client.HTTPResponse for the reader."""

    def __init__(self, status: int = 200, headers: dict[str, str] | None = None, body: bytes = b"", fail_after: int | None = None):
        self.status = status
        self._headers = {name.lower(): value for name, value in (headers or {}).items()}
        self._body = body
        self._sent = 0
        self._fail_after = fail_after

    def getheader(self, name: str, default: str | None = None) -> str | None:
        return self._headers.get(name.lower(), default)

    def read(self, size: int) -> bytes:
        if self._fail_after is not None and self._sent >= self._fail_after:
            raise ConnectionResetError("reset")
        chunk = self._body[self._sent : self._sent + size]
        self._sent += len(chunk)
        return chunk


class Web:
    """A pretend internet: {(host, path): Reply}. Records where the reader connected."""

    def __init__(self, pages: dict[tuple[str, str], Reply], names: dict[str, list[str]] | None = None):
        self.pages = pages
        self.names = names or {}
        self.connections: list[tuple[str, str, int, str]] = []  # scheme, host, port, address
        self.requests: list[tuple[str, str, dict[str, str]]] = []  # host, path, headers

    def resolver(self, host: str, port: int) -> list[str]:
        try:
            addresses = [str(ipaddress.IPv4Address(host))]  # an address is its own name
        except ValueError:
            addresses = self.names.get(host, [PUBLIC])
        for address in addresses:
            if not is_public(ipaddress.IPv4Address(address)):
                raise Refused("blocked", "private")
        return addresses

    def connector(self, target: Target, address: str, timeout: float):
        web = self
        web.connections.append((target.scheme, target.host, target.port, address))

        class Connection:
            sock = None

            def request(self, method: str, path: str, headers: dict[str, str]) -> None:
                assert method == "GET"
                web.requests.append((target.host, path, headers))
                if (target.host, path) not in web.pages:
                    raise ConnectionRefusedError("nothing there")

            def getresponse(self) -> Reply:
                return web.pages[(target.host, path_of(web))]

            def close(self) -> None:
                pass

        return Connection()

    def fetch(self, url: str, **options) -> Fetched:
        return fetch(url, resolver=self.resolver, connector=self.connector, **options)


def path_of(web: Web) -> str:
    return web.requests[-1][1]


def refusal(test: unittest.TestCase, code: str, call, *args, **kwargs) -> Refused:
    with test.assertRaises(Refused) as caught:
        call(*args, **kwargs)
    test.assertEqual(caught.exception.code, code, caught.exception.message)
    return caught.exception


class Urls(unittest.TestCase):
    def test_plain_urls_are_accepted(self):
        self.assertEqual(parse_target("https://docs.python.org/3/library/asyncio.html"), Target("https", "docs.python.org", 443, "/3/library/asyncio.html"))
        self.assertEqual(parse_target(" HTTP://Example.COM. "), Target("http", "example.com", 80, "/"))
        self.assertEqual(parse_target("https://example.com:443/a?b=c&d=e#frag"), Target("https", "example.com", 443, "/a?b=c&d=e"))
        self.assertEqual(parse_target("https://example.com/wiki/Rust_(language)?q=a b"[:-3] + "a%20b").path, "/wiki/Rust_(language)?q=a%20b")
        self.assertEqual(parse_target("https://bücher.example.com/").host, "xn--bcher-kva.example.com")
        self.assertEqual(parse_target("https://example.com/päth?q=ü").path, "/p%C3%A4th?q=%C3%BC")

    def test_everything_else_is_refused(self):
        for url in ["", "   ", None, 42, "example.com/page", "ftp://example.com/", "file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)", "//example.com/", "https://"]:
            refusal(self, "bad_url", parse_target, url)
        for url in ["https://user@example.com/", "https://user:pw@example.com/", "https://example.com/a b", "https://example.com/\x00", "https://exam\tple.com/", "https://example.com\\@evil.example/", "https://example.com/" + "a" * 2000]:
            refusal(self, "bad_url", parse_target, url)
        for url in [
            "https://example.com:8443/", "http://example.com:22/", "http://example.com:443/", "https://example.com:80/", "http://example.com:0/",
            "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fe80::1%25eth0]/", "http://[2606:4700::1111]/",
            "http://localhost/", "http://router/", "http://2130706433/", "http://017700000001/", "http://0x7f000001/",
            "http://portal.local/", "http://nas.lan/", "http://db.internal/", "http://x.localhost/", "http://a.home.arpa/", "http://x.onion/",
            "http://exa$mple.com/", "http://exa_mple-.com/",
        ]:
            refusal(self, "blocked", parse_target, url)
        for url in ["http://-bad-.example.com/", "http://" + "a" * 250 + ".com/", "http://a..b.com/"]:
            with self.assertRaises(Refused, msg=url):
                parse_target(url)
        refusal(self, "bad_url", parse_target, "http://example.com:99999/")

    def test_github_file_views_are_read_raw(self):
        raw = reader.rewrite(parse_target("https://github.com/containers/podman/blob/main/README.md?plain=1"))
        self.assertEqual(raw, Target("https", "raw.githubusercontent.com", 443, "/containers/podman/main/README.md"))
        other = parse_target("https://github.com/containers/podman/issues/1")
        self.assertEqual(reader.rewrite(other), other)


class Addresses(unittest.TestCase):
    def test_only_public_addresses_count(self):
        for address in ["8.8.8.8", "1.1.1.1", PUBLIC, "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.254"]:
            self.assertTrue(is_public(ipaddress.IPv4Address(address)), address)
        for address in [
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.100", "100.127.255.255", "127.0.0.1", "127.255.255.254",
            "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.29.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1",
            "192.168.10.14", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
        ]:
            self.assertFalse(is_public(ipaddress.IPv4Address(address)), address)

    def resolve(self, addresses: list[str]):
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses]
        with mock.patch.object(socket, "getaddrinfo", return_value=infos) as lookup:
            try:
                return resolve_public("example.com", 443)
            finally:
                self.assertEqual(lookup.call_args.kwargs["family"], socket.AF_INET, "IPv4 only")

    def test_every_address_of_a_name_must_be_public(self):
        self.assertEqual(self.resolve([PUBLIC, "1.1.1.1", PUBLIC]), [PUBLIC, "1.1.1.1"])
        for addresses in [["127.0.0.1"], [PUBLIC, "10.0.0.5"], ["192.168.10.14", PUBLIC], ["169.254.169.254"], ["0.0.0.0"], ["100.100.100.100"]]:
            with self.assertRaises(Refused) as caught:
                self.resolve(addresses)
            self.assertEqual(caught.exception.code, "blocked", addresses)

    def test_names_that_do_not_resolve(self):
        with mock.patch.object(socket, "getaddrinfo", side_effect=socket.gaierror("no such name")):
            refusal(self, "dns", resolve_public, "nope.example.com", 443)
        with mock.patch.object(socket, "getaddrinfo", return_value=[]):
            refusal(self, "dns", resolve_public, "empty.example.com", 443)

    def test_numeric_host_forms_resolve_to_what_they_mean(self):
        # The C library reads these as 127.0.0.1; whatever they resolve to is what gets checked.
        for host in ["127.1", "0x7f.0.0.1", "0177.0.0.1"]:
            try:
                refusal(self, "blocked", resolve_public, host, 80)
            except AssertionError:
                refusal(self, "dns", resolve_public, host, 80)


class Fetching(unittest.TestCase):
    def test_a_page_is_fetched_from_the_checked_address(self):
        web = Web({("example.com", "/doc?x=1"): Reply(200, {"Content-Type": "text/html; charset=ISO-8859-1"}, b"<html>hi</html>")}, {"example.com": ["1.2.3.4", "5.6.7.8"]})
        fetched = web.fetch("https://example.com/doc?x=1")
        self.assertEqual((fetched.url, fetched.status, fetched.content_type, fetched.charset, fetched.body, fetched.truncated), ("https://example.com/doc?x=1", 200, "text/html", "iso-8859-1", b"<html>hi</html>", False))
        self.assertEqual(web.connections, [("https", "example.com", 443, "1.2.3.4")], "connected to the address that was checked")
        host, path, headers = web.requests[0]
        self.assertEqual(headers["Host"], "example.com")
        self.assertNotIn("Cookie", headers)
        self.assertNotIn("Authorization", headers)
        self.assertTrue(headers["Accept"].startswith("text/markdown"))

    def test_the_next_address_is_tried_when_one_fails(self):
        web = Web({("example.com", "/"): Reply(200, {"Content-Type": "text/plain"}, b"ok")}, {"example.com": ["1.2.3.4", "5.6.7.8"]})
        attempts: list[str] = []
        real = web.connector

        def flaky(target, address, timeout):
            attempts.append(address)
            connection = real(target, address, timeout)
            if address == "1.2.3.4":
                connection.request = mock.Mock(side_effect=ConnectionRefusedError())
            return connection

        self.assertEqual(fetch("http://example.com/", resolver=web.resolver, connector=flaky).body, b"ok")
        self.assertEqual(attempts, ["1.2.3.4", "5.6.7.8"])

    def test_redirects_are_checked_like_the_first_url(self):
        web = Web(
            {
                ("example.com", "/old"): Reply(301, {"Location": "/new"}),
                ("example.com", "/new"): Reply(302, {"Location": "https://www.example.org/final"}),
                ("www.example.org", "/final"): Reply(200, {"Content-Type": "text/plain"}, b"done"),
                ("example.com", "/to-lan"): Reply(302, {"Location": "http://192.168.10.14:8080/v1/models"}),
                ("example.com", "/to-loopback"): Reply(302, {"Location": "http://localhost/admin"}),
                ("example.com", "/to-rebind"): Reply(307, {"Location": "https://rebind.example.net/"}),
                ("example.com", "/to-metadata"): Reply(302, {"Location": "http://169.254.169.254/latest/meta-data/"}),
                ("example.com", "/to-file"): Reply(302, {"Location": "file:///etc/passwd"}),
                ("example.com", "/nowhere"): Reply(302, {}),
                ("example.com", "/loop"): Reply(302, {"Location": "/loop"}),
            },
            {"rebind.example.net": ["10.0.0.7"]},
        )
        fetched = web.fetch("http://example.com/old")
        self.assertEqual((fetched.url, fetched.body), ("https://www.example.org/final", b"done"))
        self.assertEqual([connection[:3] for connection in web.connections], [("http", "example.com", 80), ("http", "example.com", 80), ("https", "www.example.org", 443)])
        refusal(self, "blocked", web.fetch, "http://example.com/to-lan")
        refusal(self, "blocked", web.fetch, "http://example.com/to-loopback")
        refusal(self, "blocked", web.fetch, "http://example.com/to-rebind")
        refusal(self, "blocked", web.fetch, "http://example.com/to-metadata")
        refusal(self, "bad_url", web.fetch, "http://example.com/to-file")
        refusal(self, "http", web.fetch, "http://example.com/nowhere")
        before = len(web.requests)
        refusal(self, "http", web.fetch, "http://example.com/loop")
        self.assertEqual(len(web.requests) - before, reader.MAX_REDIRECTS + 1)
        self.assertFalse(any(address.startswith(("10.", "192.168.", "169.254.", "127.")) for *_, address in web.connections), "never connected to a private address")

    def test_redirects_can_be_kept_on_given_sites(self):
        web = Web(
            {
                ("github.com", "/go"): Reply(302, {"Location": "https://attacker-site.net/?d=secret"}),
                ("github.com", "/docs"): Reply(302, {"Location": "https://docs.github.com/en"}),
                ("docs.github.com", "/en"): Reply(200, {"Content-Type": "text/plain"}, b"docs"),
                ("github.com", "/self"): Reply(301, {"Location": "/self/"}),
                ("github.com", "/self/"): Reply(200, {"Content-Type": "text/plain"}, b"same host"),
                ("notgithub.com", "/x"): Reply(302, {"Location": "https://evilgithub.com/"}),
                ("evilgithub.com", "/"): Reply(200, {"Content-Type": "text/plain"}, b"look-alike"),
            }
        )
        error = refusal(self, "redirect", web.fetch, "https://github.com/go", redirect_hosts=["github.com"])
        self.assertIn("attacker-site.net", error.message)
        self.assertNotIn("secret", error.message, "the refused address is not repeated in full")
        self.assertFalse(any(host == "attacker-site.net" for _, host, *_ in web.connections), "the redirect was not followed")
        self.assertEqual(web.fetch("https://github.com/docs", redirect_hosts=["github.com"]).body, b"docs")
        self.assertEqual(web.fetch("https://github.com/self", redirect_hosts=[]).body, b"same host")
        refusal(self, "redirect", web.fetch, "https://notgithub.com/x", redirect_hosts=["github.com"])
        self.assertEqual(web.fetch("https://notgithub.com/x").body, b"look-alike", "no list: redirects may lead anywhere public")

    def test_status_codes_become_messages_for_the_model(self):
        web = Web({("example.com", f"/{status}"): Reply(status, {"Content-Type": "text/html"}, b"<html>error page</html>") for status in (404, 410, 401, 403, 429, 451, 503, 500, 204 + 96)})
        for status in (404, 410):
            self.assertIn("no page", refusal(self, "http", web.fetch, f"https://example.com/{status}").message)
        for status in (401, 403, 429, 451, 503):
            self.assertIn("refused", refusal(self, "http", web.fetch, f"https://example.com/{status}").message)
        self.assertIn("HTTP 500", refusal(self, "http", web.fetch, "https://example.com/500").message)
        refusal(self, "unreachable", web.fetch, "https://example.com/not-in-the-table")

    def test_downloads_are_capped_after_decompression(self):
        limit = reader.MAX_DOWNLOAD_BYTES
        bomb = gzip.compress(b"\0" * (limit * 8))
        self.assertLess(len(bomb), limit // 50)
        deflated = zlib.compress(b"plain deflate")
        web = Web(
            {
                ("example.com", "/big"): Reply(200, {"Content-Type": "text/plain"}, b"x" * (limit + 5000)),
                ("example.com", "/bomb"): Reply(200, {"Content-Type": "text/plain", "Content-Encoding": "gzip"}, bomb),
                ("example.com", "/gz"): Reply(200, {"Content-Type": "text/plain", "Content-Encoding": "gzip"}, gzip.compress(b"hello " * 1000)),
                ("example.com", "/deflate"): Reply(200, {"Content-Type": "text/plain", "Content-Encoding": "deflate"}, deflated),
                ("example.com", "/br"): Reply(200, {"Content-Type": "text/plain", "Content-Encoding": "br"}, b"??"),
                ("example.com", "/garbage"): Reply(200, {"Content-Type": "text/plain", "Content-Encoding": "gzip"}, b"this is not gzip"),
                ("example.com", "/cut"): Reply(200, {"Content-Type": "text/plain"}, b"partial page", fail_after=12),
                ("example.com", "/dead"): Reply(200, {"Content-Type": "text/plain"}, b"", fail_after=0),
                ("example.com", "/pdf"): Reply(200, {"Content-Type": "application/pdf"}, b"%PDF-" + b"x" * (limit + 5000)),
            }
        )
        big = web.fetch("https://example.com/big")
        self.assertEqual((len(big.body), big.truncated), (limit, True))
        bombed = web.fetch("https://example.com/bomb")
        self.assertEqual((len(bombed.body), bombed.truncated), (limit, True))
        self.assertEqual(web.fetch("https://example.com/gz").body, b"hello " * 1000)
        self.assertEqual(web.fetch("https://example.com/deflate").body, b"plain deflate")
        refusal(self, "unsupported", web.fetch, "https://example.com/br")
        refusal(self, "http", web.fetch, "https://example.com/garbage")
        self.assertEqual(web.fetch("https://example.com/cut").body, b"partial page", "what arrived before the connection broke is kept")
        refusal(self, "unreachable", web.fetch, "https://example.com/dead")
        pdf = web.fetch("https://example.com/pdf")
        self.assertEqual((len(pdf.body), pdf.truncated), (limit + 5005, False), "PDFs have their own, larger limit")

    def test_a_slow_site_runs_into_the_deadline(self):
        web = Web({("example.com", "/"): Reply(200, {"Content-Type": "text/plain"}, b"late")})
        refusal(self, "timeout", web.fetch, "https://example.com/", deadline=0.0)

    def test_the_deadline_holds_against_a_site_that_drips_or_stalls(self):
        # A real socket: after the headers the site sends a byte now and then (or nothing), which never
        # fills a read buffer and never trips a per-read timeout. It used to hold the request until the kill timer.
        for pause in (0.05, 30.0):

            class Slow(socketserver.BaseRequestHandler):
                def handle(self):
                    self.request.recv(65536)
                    self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n")
                    try:
                        for _ in range(2000):
                            self.request.sendall(b"x")
                            time.sleep(pause)
                    except OSError:
                        pass

            site = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Slow)
            site.daemon_threads = True
            threading.Thread(target=site.serve_forever, daemon=True).start()
            port = site.server_address[1]
            try:
                started = time.monotonic()
                with self.assertRaises(Refused) as caught:
                    fetch(
                        "http://slow-site.net/",
                        resolver=lambda host, _port: ["127.0.0.1"],
                        connector=lambda target, address, timeout: http.client.HTTPConnection("127.0.0.1", port, timeout=timeout),
                        deadline=time.monotonic() + 0.6,
                    )
                self.assertEqual(caught.exception.code, "timeout", pause)
                self.assertLess(time.monotonic() - started, 2.0, pause)
            finally:
                site.shutdown()
                site.server_close()


def fetched(body: bytes, content_type: str = "text/html", charset: str = "", truncated: bool = False, url: str = "https://example.com/page") -> Fetched:
    return Fetched(url, 200, content_type, charset, body, truncated)


class Content(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(kind_of(fetched(b"<html>", "text/html")), "html")
        self.assertEqual(kind_of(fetched(b"<html>", "application/xhtml+xml")), "html")
        self.assertEqual(kind_of(fetched(b"# Title", "text/markdown")), "markdown")
        for content_type in ["text/plain", "text/x-python", "application/json", "application/atom+xml", "application/vnd.api+json", "text/csv"]:
            self.assertEqual(kind_of(fetched(b"data", content_type)), "text", content_type)
        self.assertEqual(kind_of(fetched(b"%PDF-1.7 ...", "application/pdf")), "pdf")
        self.assertEqual(kind_of(fetched(b"  %PDF-1.4 ...", "application/octet-stream")), "pdf", "a PDF served without its type")
        self.assertEqual(kind_of(fetched(b"<!DOCTYPE html><html>", "")), "html")
        self.assertEqual(kind_of(fetched(b"plain words", "")), "text")
        self.assertEqual(kind_of(fetched(b"PK\x03\x04\x00\x00", "application/octet-stream")), "other")
        for content_type in ["image/png", "application/zip", "video/mp4", "application/x-tar"]:
            self.assertEqual(kind_of(fetched(b"....", content_type)), "other", content_type)

    def test_text_is_decoded_with_the_declared_charset_or_utf8(self):
        self.assertEqual(reader.decode_text(fetched("grüße".encode("latin-1"), "text/plain", "iso-8859-1")), "grüße")
        self.assertEqual(reader.decode_text(fetched("grüße".encode(), "text/plain", "")), "grüße")
        self.assertEqual(reader.decode_text(fetched("grüße".encode(), "text/plain", "no-such-charset")), "grüße")
        self.assertEqual(reader.decode_text(fetched(b"gr\xff\xfe", "text/plain", "utf-8")), "gr��")

    def test_titles(self):
        self.assertEqual(reader.html_title(b"<html><head><TITLE lang=en>\n Tom &amp; Jerry \n</TITLE></head>"), "Tom & Jerry")
        self.assertEqual(reader.html_title(b"<html><body>no title</body></html>"), "")
        self.assertEqual(reader.html_title(b"<title>A</title><title>B</title>"), "A")
        self.assertEqual(reader.html_title(b"<titles>not this</titles><title>this</title>"), "this")
        started = time.monotonic()
        self.assertEqual(reader.html_title(b"<title>" * 30_000), "", "140 KB of unclosed titles used to take seconds")
        self.assertEqual(reader.html_title(b"<title " * 30_000 + b">x</title>"), "")
        self.assertLess(time.monotonic() - started, 1.0)

    def read(self, page: Fetched, **patches) -> dict:
        with mock.patch.multiple(reader, **patches) if patches else mock.patch.object(reader, "PORT", reader.PORT):
            return reader.read(page.url, fetcher=lambda url, redirect_hosts=None: page)

    def test_read_returns_text_and_markdown_as_they_are(self):
        result = self.read(fetched(b"# Title\n\nBody\x00 text\n", "text/markdown", url="https://example.com/a.md"))
        self.assertEqual(result, {"ok": True, "url": "https://example.com/a.md", "kind": "markdown", "title": "", "text": "# Title\n\nBody text", "truncated": False, "note": ""})
        cut = self.read(fetched(b"x" * 100, "text/plain", truncated=True))
        self.assertEqual((cut["kind"], cut["truncated"]), ("text", True))
        capped = self.read(fetched(b"y" * 5000, "text/plain"), MAX_OUTPUT_CHARS=1200)
        self.assertEqual((len(capped["text"]), capped["truncated"]), (1200, True))

    def test_read_refuses_what_is_not_text(self):
        self.assertEqual(refusal(self, "unsupported", self.read, fetched(b"\x89PNG....", "image/png")).message, "That URL is a image/png file, which cannot be read as text.")
        refusal(self, "too_large", self.read, fetched(b"%PDF-1.7", "application/pdf", truncated=True))
        with mock.patch.object(reader, "extract_html", return_value=("  \n", "")):
            self.assertIn("JavaScript", refusal(self, "empty", self.read, fetched(b"<html><body><div id=root></div></body></html>")).message)
        with mock.patch.object(reader, "extract_html", return_value=("# Doc\n\nText", "A note.")) as extract_html:
            page = self.read(fetched(b"<html><head><title>Doc page</title></head><body>...</body></html>", charset="koi8-r"))
        self.assertEqual((page["kind"], page["title"], page["text"], page["note"]), ("html", "Doc page", "# Doc\n\nText", "A note."))
        self.assertEqual(extract_html.call_args.args[1:], ("https://example.com/page", "koi8-r"))


class Service(unittest.TestCase):
    """The HTTP server, with one forked process per request, as the gateway uses it."""

    @classmethod
    def setUpClass(cls):
        cls.server = reader.Server(("127.0.0.1", 0), reader.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, path: str, body: bytes) -> tuple[int, dict]:
        request = urllib.request.Request(self.base + path, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_health(self):
        with urllib.request.urlopen(self.base + "/healthz", timeout=5) as response:
            self.assertEqual((response.status, json.load(response)), (200, {"ok": True}))

    def test_refusals_are_answers_not_errors(self):
        for url, code in [("http://127.0.0.1/", "blocked"), ("http://localhost:8080/", "blocked"), ("file:///etc/passwd", "bad_url"), ("http://169.254.169.254/latest/", "blocked"), (17, "bad_url")]:
            status, answer = self.post("/read", json.dumps({"url": url}).encode())
            self.assertEqual((status, answer["ok"], answer["code"]), (200, False, code), url)
            self.assertTrue(answer["message"])

    def test_requests_wait_for_a_place_and_the_health_check_does_not(self):
        body = json.dumps({"url": "http://127.0.0.1/"}).encode()
        # Up to two seconds each: a request process of an earlier test may still be on its way out.
        held = [slot for slot in (reader.take_slot(2) for _ in range(reader.MAX_CONCURRENT)) if slot is not None]
        try:
            self.assertEqual(len(held), reader.MAX_CONCURRENT)
            self.assertIsNone(reader.take_slot(0), "every place is taken")
            with mock.patch.object(reader, "SLOT_WAIT_SECONDS", 0.3):
                started = time.monotonic()
                status, answer = self.post("/read", body)
                self.assertEqual((status, answer["ok"], answer["code"]), (200, False, "busy"))
                self.assertGreaterEqual(time.monotonic() - started, 0.3)
                self.test_health()
        finally:
            for slot in held:
                os.close(slot)
        deadline = time.monotonic() + 5  # request processes forked meanwhile hold the locks until they exit
        while True:
            answer = self.post("/read", body)[1]
            if answer["code"] != "busy" or time.monotonic() > deadline:
                break
            time.sleep(0.1)
        self.assertEqual(answer["code"], "blocked", "with a place free, the request is handled")

    def test_bad_requests(self):
        for body in [b"", b"not json", b"[]", b"{}", b'"https://example.com/"', json.dumps({"url": "https://example.com/", "redirect_hosts": "github.com"}).encode(), b"x" * 70_000]:
            status, answer = self.post("/read", body)
            self.assertEqual((status, answer["ok"], answer["code"]), (200, False, "bad_request"), body[:40])
        self.assertEqual(self.post("/other", b"{}")[0], 404)


if __name__ == "__main__":
    unittest.main()
