#!/usr/bin/env python3
"""Workspace Portal page reader: turns one public web page (or PDF) into text for the gateway, its only client.

The rule that keeps it safe: it connects only to public IPv4 addresses, on ports 80 and 443, and to the very
address it checked (the name is used only for TLS and the Host header); every redirect is checked the same way.
Each request is a process of its own with limits on time, bytes and memory, so a hostile page ends at worst
its own request.
"""
from __future__ import annotations

import fcntl
import html
import http.client
import ipaddress
import json
import os
import re
import resource
import signal
import socket
import ssl
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ForkingMixIn
from typing import Callable, Iterable
from urllib.parse import quote, urljoin, urlsplit

import extract


def env_int(name: str, default: int, minimum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        sys.exit(f"{name} must be an integer (got {raw!r})")
    if value < minimum:
        sys.exit(f"{name} must be at least {minimum} (got {value})")
    return value


PORT = 8080
MAX_CONCURRENT = env_int("READER_MAX_CONCURRENT", 2, 1)
TIMEOUT_SECONDS = env_int("READER_FETCH_TIMEOUT_SECONDS", 20, 5)
MAX_DOWNLOAD_BYTES = env_int("READER_MAX_DOWNLOAD_MB", 5, 1) * 1024 * 1024
MAX_PDF_BYTES = env_int("READER_MAX_PDF_MB", 15, 1) * 1024 * 1024
MAX_PDF_PAGES = env_int("READER_MAX_PDF_PAGES", 60, 1)
MAX_OUTPUT_CHARS = 400_000
USER_AGENT = os.environ.get("READER_USER_AGENT", "").strip() or "Mozilla/5.0 (compatible; WorkspacePortalReader/1.0)"

MAX_REDIRECTS = 5
MAX_URL_CHARS = 2000
CONNECT_TIMEOUT = 8.0
# Up to MAX_WAITING requests beyond MAX_CONCURRENT wait SLOT_WAIT_SECONDS for a turn, each in a process of its own.
MAX_WAITING = 14
SLOT_WAIT_SECONDS = 30
SLOT_DIR = tempfile.gettempdir()
# Per-request process limits: a kill timer past the fetch and conversion timeouts, CPU seconds, and heap.
HARD_KILL_SECONDS = TIMEOUT_SECONDS + 35
CPU_SECONDS = 30
HEAP_BYTES = 320 * 1024 * 1024

ACCEPT = "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, application/pdf;q=0.7, */*;q=0.1"

# Everything that is not the public internet (IANA special-purpose registry), on top of is_global.
BLOCKED_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
        "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
        "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    )
)
LOCAL_SUFFIXES = (".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".localdomain", ".test", ".invalid", ".example", ".onion")
HOST_PATTERN = re.compile(r"^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+$")
REDIRECT_STATUSES = (301, 302, 303, 307, 308)


class Refused(Exception):
    """A read that cannot be done; `message` is written for the model."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Target:
    scheme: str
    host: str
    port: int
    path: str  # path and query, ready for the request line

    @property
    def url(self) -> str:
        return f"{self.scheme}://{self.host}{self.path}"


def is_public(address: ipaddress.IPv4Address) -> bool:
    return address.is_global and not any(address in network for network in BLOCKED_NETWORKS)


def parse_target(raw: str) -> Target:
    """Validates a URL and returns what to connect to. Raises Refused."""
    if not isinstance(raw, str) or not raw.strip():
        raise Refused("bad_url", "Give the full URL of the page, starting with https://.")
    raw = raw.strip()
    if len(raw) > MAX_URL_CHARS:
        raise Refused("bad_url", f"The URL is longer than {MAX_URL_CHARS} characters.")
    if any(ord(char) < 0x21 or ord(char) == 0x7F for char in raw) or "\\" in raw:
        raise Refused("bad_url", "The URL contains spaces, control characters or backslashes.")
    try:
        parts = urlsplit(raw)
        port = parts.port
        host = parts.hostname or ""
    except ValueError:
        raise Refused("bad_url", "That is not a valid URL.") from None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise Refused("bad_url", "Only http:// and https:// pages can be read.")
    if "@" in parts.netloc:
        raise Refused("bad_url", "URLs with a user name or password in them are not read.")
    if port is not None and port != (443 if scheme == "https" else 80):
        raise Refused("blocked", "Only the standard web ports (80 and 443) can be read.")
    host = host.rstrip(".").lower()
    if not host:
        raise Refused("bad_url", "The URL has no host name.")
    if ":" in host:
        raise Refused("blocked", "IPv6 addresses are not supported; use the site's name.")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        raise Refused("bad_url", "The host name in the URL is not valid.") from None
    if not HOST_PATTERN.match(host) or len(host) > 253:
        raise Refused("blocked", "Only public internet sites can be read: that host name is not one.")
    if host.endswith(LOCAL_SUFFIXES):
        raise Refused("blocked", "Only public internet sites can be read: that name belongs to a private network.")
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=~-._")
    if parts.query:
        path += "?" + quote(parts.query, safe="/%:@!$&'()*+,;=~-._?[]")
    return Target(scheme, host, 443 if scheme == "https" else 80, path)


def resolve_public(host: str, port: int) -> list[str]:
    """Every IPv4 address of `host`, provided all of them are public. Raises Refused."""
    try:
        infos = socket.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise Refused("dns", f"The name {host} does not exist or has no IPv4 address.") from None
    addresses = list(dict.fromkeys(str(info[4][0]) for info in infos))
    if not addresses:
        raise Refused("dns", f"The name {host} has no IPv4 address.")
    for address in addresses:
        if not is_public(ipaddress.IPv4Address(address)):
            raise Refused("blocked", "Only public internet sites can be read: that address is on a private or reserved network.")
    return addresses


class PinnedConnection(http.client.HTTPConnection):
    """Connects to an address that was already checked; the host name is only sent in the request."""

    def __init__(self, target: Target, address: str, timeout: float, context: ssl.SSLContext | None):
        super().__init__(target.host, target.port, timeout=timeout)
        self._address = address
        self._tls = context

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        if self._tls is not None:
            sock = self._tls.wrap_socket(sock, server_hostname=self.host)
        self.sock = sock


@dataclass
class Fetched:
    url: str
    status: int
    content_type: str
    charset: str
    body: bytes
    truncated: bool


Resolver = Callable[[str, int], list[str]]
Connector = Callable[[Target, str, float], http.client.HTTPConnection]

_TLS = ssl.create_default_context()


def connect_pinned(target: Target, address: str, timeout: float) -> http.client.HTTPConnection:
    return PinnedConnection(target, address, timeout, _TLS if target.scheme == "https" else None)


def rewrite(target: Target) -> Target:
    """A GitHub file view is a JavaScript page; its raw form is the file itself."""
    if target.host == "github.com":
        match = re.match(r"^/([^/]+)/([^/]+)/(?:blob|raw)/(.+)$", target.path.split("?", 1)[0])
        if match:
            return Target("https", "raw.githubusercontent.com", 443, f"/{match[1]}/{match[2]}/{match[3]}")
    return target


def same_site(host: str, sites: Iterable[str]) -> bool:
    """True when `host` is one of `sites` or a subdomain of one."""
    return any(host == site or host.endswith("." + site) for site in sites)


def fetch(
    url: str,
    resolver: Resolver = resolve_public,
    connector: Connector = connect_pinned,
    deadline: float | None = None,
    redirect_hosts: Iterable[str] | None = None,
) -> Fetched:
    """GETs a public page, following checked redirects. Raises Refused.

    `redirect_hosts`: when given, a redirect may only stay on its own host or lead to one of these
    sites. The gateway sets it for a URL the model may have put together itself, so that a
    redirecting page on a trusted site cannot pass the request on to someone else.
    """
    deadline = time.monotonic() + TIMEOUT_SECONDS if deadline is None else deadline
    target = rewrite(parse_target(url))
    fence = None if redirect_hosts is None else tuple(redirect_hosts)
    for _ in range(MAX_REDIRECTS + 1):
        addresses = resolver(target.host, target.port)
        response, connection, sock = _request(target, addresses, connector, deadline)
        try:
            status = response.status
            if status in REDIRECT_STATUSES:
                location = response.getheader("Location")
                if not location:
                    raise Refused("http", f"The site answered HTTP {status} without saying where to go.")
                onward = rewrite(parse_target(urljoin(target.url, location.strip())))
                if fence is not None and onward.host != target.host and not same_site(onward.host, fence):
                    raise Refused("redirect", f"That address redirects to another site ({onward.host}), and the redirect was not followed.")
                target = onward
                continue
            if status in (404, 410):
                raise Refused("http", f"There is no page at that URL (HTTP {status}).")
            if status in (401, 403, 429, 451, 503):
                raise Refused("http", f"The site refused the request (HTTP {status}); it may block automated readers or want a sign-in. Try another source.")
            if status < 200 or status >= 300:
                raise Refused("http", f"The site answered HTTP {status}.")
            content_type, charset = _content_type(response.getheader("Content-Type"))
            limit = MAX_PDF_BYTES if content_type == "application/pdf" else MAX_DOWNLOAD_BYTES
            body, truncated = _read_body(response, limit, deadline, sock)
            return Fetched(target.url, status, content_type, charset, body, truncated)
        finally:
            connection.close()
    raise Refused("http", f"The site redirected more than {MAX_REDIRECTS} times.")


def _request(target: Target, addresses: Iterable[str], connector: Connector, deadline: float):
    headers = {
        "Host": target.host,
        "User-Agent": USER_AGENT,
        "Accept": ACCEPT,
        "Accept-Language": "en;q=0.9, *;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "close",
    }
    failure: Exception | None = None
    for address in addresses:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        connection = connector(target, address, min(CONNECT_TIMEOUT, remaining))
        try:
            connection.request("GET", target.path, headers=headers)
            # Kept for _read_body: the connection lets go of its socket once the response headers are in.
            sock = connection.sock
            if sock is not None:
                sock.settimeout(max(0.5, deadline - time.monotonic()))
            return connection.getresponse(), connection, sock
        except ssl.SSLCertVerificationError:
            connection.close()
            raise Refused("tls", f"The certificate of {target.host} is not valid, so the page was not read.") from None
        except (OSError, http.client.HTTPException) as error:
            connection.close()
            failure = error
    if isinstance(failure, TimeoutError) or failure is None:
        raise Refused("timeout", f"{target.host} did not answer in time.")
    raise Refused("unreachable", f"Could not connect to {target.host}.")


def _content_type(header: str | None) -> tuple[str, str]:
    if not header:
        return "", ""
    mime, _, rest = header.partition(";")
    match = re.search(r"charset\s*=\s*\"?([A-Za-z0-9._:-]+)", rest)
    return mime.strip().lower(), (match[1].lower() if match else "")


def _read_body(response: http.client.HTTPResponse, limit: int, deadline: float, sock: socket.socket | None) -> tuple[bytes, bool]:
    """The decoded body, cut at `limit` bytes (counted after decompression).

    The deadline holds however the site sends: each read returns what has arrived instead of waiting
    for a full buffer, and waits no longer than the time that is left. A site that sends a byte
    every few seconds would otherwise hold the request, and its place in the queue, until the kill timer.
    """
    encoding = (response.getheader("Content-Encoding") or "").strip().lower()
    if encoding in ("gzip", "x-gzip"):
        inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    elif encoding == "deflate":
        inflater = zlib.decompressobj()
    elif encoding in ("", "identity"):
        inflater = None
    else:
        raise Refused("unsupported", f"The site sent its page in a compression this reader does not support ({encoding}).")
    chunks: list[bytes] = []
    size = 0
    try:
        while size <= limit:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Refused("timeout", "The site was too slow sending the page.")
            if sock is not None:
                sock.settimeout(max(0.05, remaining))
            chunk = response.read1(64 * 1024)
            if not chunk:
                break
            if inflater is None:
                chunks.append(chunk)
                size += len(chunk)
                continue
            while chunk and size <= limit:
                piece = inflater.decompress(chunk, limit + 1 - size)
                chunks.append(piece)
                size += len(piece)
                chunk = inflater.unconsumed_tail
    except zlib.error:
        raise Refused("http", "The site sent a page that could not be decompressed.") from None
    except TimeoutError:
        raise Refused("timeout", "The site was too slow sending the page.") from None
    except (OSError, http.client.HTTPException):
        if not chunks:
            raise Refused("unreachable", "The connection broke while the page was being read.") from None
    body = b"".join(chunks)
    return (body[:limit], True) if len(body) > limit else (body, False)


# ------------------------------------------------------------------ turning a response into text

TEXT_TYPES = {
    "application/json", "application/ld+json", "application/xml", "application/javascript", "application/x-javascript",
    "application/x-yaml", "application/yaml", "application/toml", "application/x-sh", "application/x-ndjson",
    "application/rss+xml", "application/atom+xml", "application/sql",
}
HTML_TYPES = {"text/html", "application/xhtml+xml"}


def kind_of(fetched: Fetched) -> str:
    head = fetched.body[:1024].lstrip().lower()
    if fetched.content_type == "application/pdf" or head.startswith(b"%pdf-"):
        return "pdf"
    if fetched.content_type in HTML_TYPES:
        return "html"
    if fetched.content_type == "text/markdown":
        return "markdown"
    if fetched.content_type.startswith("text/") or fetched.content_type in TEXT_TYPES or fetched.content_type.endswith(("+json", "+xml")):
        return "text"
    if fetched.content_type in ("", "application/octet-stream", "binary/octet-stream"):
        if head.startswith((b"<!doctype html", b"<html")):
            return "html"
        if b"\x00" not in fetched.body[:4096]:
            return "text"
    return "other"


def html_title(body: bytes) -> str:
    """The text of the first <title>. Two plain searches: a page of unclosed <title> tags costs nothing extra."""
    head = body[:200_000]
    opening = re.search(rb"<title(?:\s[^>]{0,1000})?>", head, re.I)
    if not opening:
        return ""
    closing = re.compile(rb"</title", re.I).search(head, opening.end(), opening.end() + 4000)
    if not closing:
        return ""
    return re.sub(r"\s+", " ", html.unescape(head[opening.end() : closing.start()].decode("utf-8", errors="replace"))).strip()[:300]


def extract_pdf(body: bytes) -> tuple[str, int, int]:
    """(text, pages read, pages in the file)."""
    import pypdfium2

    try:
        document = pypdfium2.PdfDocument(body)
    except Exception:
        raise Refused("unsupported", "That PDF could not be opened (it may be damaged or password-protected).") from None
    total = len(document)
    parts: list[str] = []
    size = 0
    read = 0
    for index in range(min(total, MAX_PDF_PAGES)):
        try:
            text = document[index].get_textpage().get_text_bounded()
        except Exception:
            text = ""
        text = re.sub(r"[ \t]+\n", "\n", text.replace("\r\n", "\n").replace("\r", "\n")).strip()
        read = index + 1
        if text:
            parts.append(f"## Page {index + 1}\n\n{text}")
            size += len(text)
        if size > MAX_OUTPUT_CHARS:
            break
    return "\n\n".join(parts), read, total


def read(url: str, redirect_hosts: Iterable[str] | None = None, fetcher: Callable[..., Fetched] = fetch) -> dict:
    """The whole job: fetch `url` and return the JSON answer for the gateway. Raises Refused."""
    fetched = fetcher(url, redirect_hosts=redirect_hosts)
    kind = kind_of(fetched)
    title = note = ""
    if kind == "html":
        title = html_title(fetched.body)
        text, note = extract.html_to_markdown(fetched.body, fetched.url, fetched.charset)
        if not text.strip():
            raise Refused("empty", "The page has no readable text without JavaScript (this reader has no browser). Try another source.")
    elif kind == "pdf":
        if fetched.truncated:
            raise Refused("too_large", f"That PDF is larger than {MAX_PDF_BYTES // (1024 * 1024)} MB.")
        text, pages, total = extract_pdf(fetched.body)
        if not text.strip():
            raise Refused("empty", "That PDF has no text layer (it is probably scanned images).")
        if pages < total:
            note = f"Only the first {pages} of {total} pages were read."
    elif kind in ("markdown", "text"):
        text = extract.decode(fetched.body, fetched.charset)
    else:
        raise Refused("unsupported", f"That URL is a {fetched.content_type or 'binary'} file, which cannot be read as text.")
    text = text.replace("\x00", "").strip()
    truncated = fetched.truncated and kind != "pdf"
    if len(text) > MAX_OUTPUT_CHARS:
        text, truncated = text[:MAX_OUTPUT_CHARS], True
    return {"ok": True, "url": fetched.url, "kind": kind, "title": title, "text": text, "truncated": truncated, "note": note}


# ------------------------------------------------------------------ HTTP server

def log(event: str, **fields: object) -> None:
    print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, **fields}), file=sys.stderr, flush=True)


def take_slot(wait_seconds: float) -> int | None:
    """Waits for one of the MAX_CONCURRENT places to work in: a lock on a file, which the kernel
    releases when this process ends, however it ends. None when none came free in time."""
    slots = [os.open(os.path.join(SLOT_DIR, f"reader-slot-{number}"), os.O_RDWR | os.O_CREAT, 0o600) for number in range(MAX_CONCURRENT)]
    give_up = time.monotonic() + wait_seconds
    while True:
        for slot in slots:
            try:
                fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            for other in slots:
                if other != slot:
                    os.close(other)
            return slot
        if time.monotonic() >= give_up:
            for slot in slots:
                os.close(slot)
            return None
        time.sleep(0.05)


class Handler(BaseHTTPRequestHandler):
    server_version = "workspace-portal-reader"
    sys_version = ""
    timeout = 15  # for a client that connects and then says nothing

    def log_message(self, format: str, *args: object) -> None:  # the per-request log line is ours
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        try:
            self.end_headers()
            self.wfile.write(body)
        except OSError:  # the gateway stopped waiting; nobody is left to tell
            log("client_gone", bytes=len(body))

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"ok": False, "code": "not_found", "message": "Unknown route."})

    def do_POST(self) -> None:
        if self.path != "/read":
            return self._send(404, {"ok": False, "code": "not_found", "message": "Unknown route."})
        # This process serves exactly this request: bound what a hostile page can make it do.
        signal.alarm(int(SLOT_WAIT_SECONDS) + 10)
        if take_slot(SLOT_WAIT_SECONDS) is None:
            log("refused", host="", code="busy", ms=round(SLOT_WAIT_SECONDS * 1000))
            return self._send(200, {"ok": False, "code": "busy", "message": "The page reader is busy with other pages. Try again in a moment."})
        signal.alarm(HARD_KILL_SECONDS)
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
        # A soft limit: the HTML converter is a process of its own and lifts it for itself (extract.py).
        resource.setrlimit(resource.RLIMIT_DATA, (HEAP_BYTES, resource.getrlimit(resource.RLIMIT_DATA)[1]))
        started = time.monotonic()
        host = ""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 64 * 1024:
                raise Refused("bad_request", "Send a small JSON body with a url.")
            try:
                body = json.loads(self.rfile.read(length))
                url = body["url"]
                fence = body.get("redirect_hosts")
            except (ValueError, KeyError, TypeError, AttributeError):
                raise Refused("bad_request", "Send a JSON body with a url.") from None
            if fence is not None and not (isinstance(fence, list) and all(isinstance(site, str) for site in fence)):
                raise Refused("bad_request", "redirect_hosts must be a list of host names.")
            try:
                host = (urlsplit(url).hostname or "") if isinstance(url, str) else ""
            except ValueError:
                host = ""
            answer = read(url, fence)
            event, fields = "read", {"kind": answer["kind"], "chars": len(answer["text"]), "truncated": answer["truncated"]}
        except Refused as refusal:
            event, fields, answer = "refused", {"code": refusal.code}, {"ok": False, "code": refusal.code, "message": refusal.message}
        except MemoryError:
            event, fields, answer = "refused", {"code": "too_large"}, {"ok": False, "code": "too_large", "message": "That page is too large to read."}
        except Exception as error:  # a parser bug must not take the answer with it
            event, fields, answer = "failed", {"error": type(error).__name__}, {"ok": False, "code": "failed", "message": "The page could not be turned into text."}
        log(event, host=host, **fields, ms=round((time.monotonic() - started) * 1000))
        try:
            self._send(200, answer)
        except MemoryError:  # serialising a page that only just fitted
            self._send(200, {"ok": False, "code": "too_large", "message": "That page is too large to read."})


class Server(ForkingMixIn, HTTPServer):
    # Processes, not pages at work: those are counted by take_slot. The health check must get an
    # answer while every place is taken, so the server keeps accepting.
    max_children = MAX_CONCURRENT + MAX_WAITING
    allow_reuse_address = True
    request_queue_size = 32
    block_on_close = False


def main() -> None:
    import pypdfium2  # noqa: F401  (here, so that every request process starts with it in memory)

    # Without the converter every page would come back uncleaned.
    probe = extract.convert("<html><head><title>Probe</title></head><body><article><h1>Probe</h1><p>The converter works.</p></article></body></html>", "https://example.com/")
    if probe is None or "The converter works." not in probe["markdown"]:
        sys.exit("the HTML converter (node extract.mjs) does not run")

    server = Server(("0.0.0.0", PORT), Handler)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("listening", port=PORT, concurrent=MAX_CONCURRENT, timeout=TIMEOUT_SECONDS)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
