"""Read search hits off DuckDuckGo's HTML results page (`html.duckduckgo.com/html/`).

A page meant for browsers, so it changes shape and rate-limits per source address,
and both arrive as a 200 carrying no results; `classify` therefore makes an
unreadable page a failure rather than an empty web. Parsed with stdlib `html.parser`.
"""

from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import parse_qs, urlparse

from scooter_broker_lib.search import MAX_RESULTS, SearchHit

# The result anchor and its snippet on the HTML endpoint.
RESULT_CLASS = "result__a"
SNIPPET_CLASS = "result__snippet"

# Ads carry `result__a` like any other hit, so the href is what tells them apart.
AD_PATH = "/y.js"

# Lowercased markers of a bot check, kept narrow because they outrank the no-results markers in `classify`.
BLOCKED_MARKERS = (
    "anomaly",
    "bots use duckduckgo",
    "challenge-form",
)
# Markers that DDG said the web had nothing, the only case where no hits is the truth.
NO_RESULTS_MARKERS = (
    "no results.",
    "no results found",
    "no-results",
    'class="no-results"',
)


class _ResultParser(HTMLParser):
    """Collect (title, href, snippet) triples in document order, keyed on the two stable anchor classes."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict[str, str]] = []
        self._capturing: str | None = None
        self._href = ""
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = (attributes.get("class") or "").split()
        if tag == "a" and RESULT_CLASS in classes:
            self._emit()
            self._capturing = "title"
            self._href = attributes.get("href") or ""
        elif SNIPPET_CLASS in classes:
            self._emit()
            self._capturing = "snippet"

    def handle_endtag(self, tag: str) -> None:
        # A snippet may be an <a>, a <div> or a <td> depending on which variant of the page answered.
        if self._capturing == "title" and tag == "a":
            self._emit()
        elif self._capturing == "snippet" and tag in ("a", "div", "td", "span"):
            self._emit()

    def handle_data(self, data: str) -> None:
        if self._capturing is not None:
            self._chunks.append(data)

    def close(self) -> None:  # noqa: D102
        super().close()
        self._emit()

    def _emit(self) -> None:
        if self._capturing is None:
            return
        text = " ".join("".join(self._chunks).split())
        if self._capturing == "title":
            self.rows.append({"title": text, "href": self._href, "snippet": ""})
        elif self.rows and not self.rows[-1]["snippet"]:
            self.rows[-1]["snippet"] = text
        self._capturing = None
        self._chunks = []
        self._href = ""


def target_url(href: str) -> str:
    """The real destination behind a result link (DDG wraps most hits in `//duckduckgo.com/l/?uddg=<encoded>`), or ""."""
    link = (href or "").strip()
    if not link:
        return ""
    if link.startswith("//"):
        link = f"https:{link}"
    parsed = urlparse(link)
    if "uddg" in parse_qs(parsed.query):
        inner = parse_qs(parsed.query)["uddg"][0].strip()
        return inner if urlparse(inner).scheme in ("http", "https") else ""
    if parsed.scheme not in ("http", "https"):
        return ""
    return link


def is_ad(url: str) -> bool:
    """A sponsored link, which is dropped."""
    return urlparse(url).path.startswith(AD_PATH)


def hits_from_html(page: str) -> list[SearchHit]:
    """Every result on the page, in DDG's own order, capped like any other provider."""
    parser = _ResultParser()
    parser.feed(page)
    parser.close()

    hits: list[SearchHit] = []
    for row in parser.rows:
        url = target_url(row["href"])
        if not url or is_ad(url):
            continue
        hits.append(
            SearchHit(title=row["title"] or url, url=url, snippet=row["snippet"] or None)
        )
        if len(hits) >= MAX_RESULTS:
            break
    return hits


def classify(page: str) -> str:
    """Why a page yielded no hits: "blocked" (checked first), "empty" (the only successful case), or "unrecognized"."""
    lowered = page.lower()
    if any(marker in lowered for marker in BLOCKED_MARKERS):
        return "blocked"
    if any(marker in lowered for marker in NO_RESULTS_MARKERS):
        return "empty"
    return "unrecognized"
