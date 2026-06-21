#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

WB_ARTICLE_RE = re.compile(r"^\d{5,10}$")
TOKEN_SPLIT_RE = re.compile(r"[\s,;]+")
DEFAULT_MAX_PHOTOS = 15
DEFAULT_MAX_BASKET = 60
DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_WORKERS = 8
BASKET_BATCH_SIZE = 15
HTTP_USER_AGENT = "e-comet-agent-skills/wb-product-images"

# Mirrors the app's `misc/wb_baskets` media ranges. Keep this as a fast fallback
# for standalone use; `--basket-config` can supply the live app mapping.
BASKET_VOLUME_UPPER_BOUNDS = [
    143,
    287,
    431,
    719,
    1007,
    1061,
    1115,
    1169,
    1313,
    1601,
    1655,
    1919,
    2045,
    2189,
    2405,
    2621,
    2837,
    3053,
    3269,
    3485,
    3701,
    3917,
    4133,
    4349,
    4565,
    4877,
    5189,
    5501,
    5813,
    6125,
    6437,
    6749,
    7061,
    7373,
    7685,
    7997,
    8309,
    8741,
    9173,
    9605,
    10373,
    11141,
    11909,
    12677,
    13445,
    14213,
]


@dataclass(frozen=True)
class BasketRange:
    host: str
    vol_range_from: int
    vol_range_to: int


@dataclass(frozen=True)
class BasketConfig:
    media_ranges: tuple[BasketRange, ...]

    @classmethod
    def from_json_data(cls, data: Any) -> BasketConfig:
        baskets = unwrap_basket_payload(data)
        media_basket = next((basket for basket in baskets if basket.get("name") == "media"), None)

        if media_basket is None:
            raise ValueError("basket config must contain a media basket")

        ranges = []
        for raw_host in media_basket.get("hosts", []):
            host = raw_host.get("host")
            vol_range_from = get_range_value(raw_host, "vol_range_from", "volRangeFrom")
            vol_range_to = get_range_value(raw_host, "vol_range_to", "volRangeTo")

            if not isinstance(host, str) or not isinstance(vol_range_from, int) or not isinstance(vol_range_to, int):
                raise ValueError("basket config hosts must contain host, vol_range_from, and vol_range_to")

            ranges.append(
                BasketRange(
                    host=normalize_host(host),
                    vol_range_from=vol_range_from,
                    vol_range_to=vol_range_to,
                )
            )

        if not ranges:
            raise ValueError("basket config media basket must contain at least one host range")

        return cls(media_ranges=tuple(sorted(ranges, key=lambda range_: range_.vol_range_from)))

    def host_for_volume(self, volume: int) -> str | None:
        for range_ in self.media_ranges:
            if range_.vol_range_from <= volume <= range_.vol_range_to:
                return range_.host

        return None


@dataclass(frozen=True)
class ProbeResult:
    exists: bool
    status: int | None = None
    error: str | None = None


@dataclass(frozen=True)
class BaseUrl:
    host: str
    url: str


Probe = Callable[[str, float], ProbeResult]


def unwrap_basket_payload(data: Any) -> list[Mapping[str, Any]]:
    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for key in ("wb_baskets", "baskets", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return value

    raise ValueError("basket config must be a list or an object containing wb_baskets, baskets, or data")


def get_range_value(mapping: Mapping[str, Any], snake_key: str, camel_key: str) -> int | None:
    value = mapping.get(snake_key, mapping.get(camel_key))
    return value if isinstance(value, int) else None


def normalize_host(host: str) -> str:
    stripped = host.strip()
    stripped = stripped.removeprefix("https://").removeprefix("http://")
    return stripped.split("/", 1)[0]


def split_id_tokens(text: str) -> list[str]:
    return [token for token in TOKEN_SPLIT_RE.split(text.strip()) if token]


def parse_article_ids(values: Iterable[str]) -> list[int]:
    tokens: list[str] = []
    for value in values:
        tokens.extend(split_id_tokens(str(value)))

    invalid = [token for token in tokens if not WB_ARTICLE_RE.fullmatch(token)]
    if invalid:
        raise ValueError(f"invalid WB article id(s): {', '.join(invalid)}")

    articles = []
    seen = set()
    for token in tokens:
        article = int(token)
        if article not in seen:
            articles.append(article)
            seen.add(article)

    if not articles:
        raise ValueError("provide at least one WB article id")

    return articles


def load_article_ids(positional_values: Sequence[str], input_file: str | None) -> list[int]:
    values = list(positional_values)

    if input_file:
        if input_file == "-":
            values.append(sys.stdin.read())
        else:
            values.append(Path(input_file).read_text(encoding="utf-8"))

    return parse_article_ids(values)


def load_basket_config(path: str | None) -> BasketConfig | None:
    if path is None:
        return None

    with Path(path).open(encoding="utf-8") as file_:
        return BasketConfig.from_json_data(json.load(file_))


def volume_for_article(article: int) -> int:
    return article // 100000


def part_for_article(article: int) -> int:
    return article // 1000


def basket_number_for_volume(volume: int) -> int:
    for basket_number, upper_bound in enumerate(BASKET_VOLUME_UPPER_BOUNDS, start=1):
        if volume <= upper_bound:
            return basket_number

    return len(BASKET_VOLUME_UPPER_BOUNDS) + 1


def fallback_basket_numbers(volume: int, max_basket: int) -> tuple[int, ...]:
    first_future_basket = len(BASKET_VOLUME_UPPER_BOUNDS) + 1
    if volume > BASKET_VOLUME_UPPER_BOUNDS[-1] and first_future_basket <= max_basket:
        return tuple(range(first_future_basket, max_basket + 1)) + tuple(range(1, first_future_basket))

    return tuple(range(1, max_basket + 1))


def basket_host(basket_number: int) -> str:
    return f"basket-{basket_number:02d}.wbbasket.ru"


def build_base_url(article: int, host: str, size: str) -> str:
    volume = volume_for_article(article)
    part = part_for_article(article)
    return f"https://{normalize_host(host)}/vol{volume}/part{part}/{article}/images/{size}/"


def build_probe_url(base_url: str, image_number: int) -> str:
    return f"{base_url}{image_number}.webp"


def probe_url_exists(url: str, timeout: float) -> ProbeResult:
    head_result = probe_request(url, "HEAD", timeout)
    if head_result.exists:
        return head_result

    if head_result.status in {405, 501} or head_result.status is None:
        return probe_request(url, "GET", timeout)

    return head_result


def probe_request(url: str, method: str, timeout: float) -> ProbeResult:
    headers = {
        "Accept": "image/webp,*/*;q=0.8",
        "User-Agent": HTTP_USER_AGENT,
    }
    if method == "GET":
        headers["Range"] = "bytes=0-0"

    request = urllib.request.Request(url, headers=headers, method=method)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            valid_statuses = {200, 206} if method == "GET" else {200}
            return ProbeResult(exists=status in valid_statuses, status=status)
    except urllib.error.HTTPError as error:
        return ProbeResult(exists=False, status=error.code)
    except (OSError, TimeoutError, urllib.error.URLError) as error:
        return ProbeResult(exists=False, error=str(error))


def probe_many(items: Sequence[tuple[int, str]], timeout: float, workers: int, probe: Probe) -> dict[int, ProbeResult]:
    if not items:
        return {}

    max_workers = max(1, min(workers, len(items)))
    results: dict[int, ProbeResult] = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(safe_probe, probe, url, timeout): key for key, url in items}

        for future in concurrent.futures.as_completed(futures):
            results[futures[future]] = future.result()

    return results


def safe_probe(probe: Probe, url: str, timeout: float) -> ProbeResult:
    try:
        return probe(url, timeout)
    except Exception as error:  # pragma: no cover - defensive boundary for custom probes.
        return ProbeResult(exists=False, error=str(error))


def find_working_base_url(
    article: int,
    size: str,
    basket_config: BasketConfig | None,
    max_basket: int,
    timeout: float,
    workers: int,
    probe: Probe = probe_url_exists,
) -> BaseUrl | None:
    volume = volume_for_article(article)
    checked_hosts: set[str] = set()

    def check_host(host: str) -> BaseUrl | None:
        normalized_host = normalize_host(host)
        if normalized_host in checked_hosts:
            return None

        checked_hosts.add(normalized_host)
        base_url = build_base_url(article, normalized_host, size)
        if safe_probe(probe, build_probe_url(base_url, 1), timeout).exists:
            return BaseUrl(host=normalized_host, url=base_url)

        return None

    if basket_config:
        media_host = basket_config.host_for_volume(volume)
        if media_host:
            found = check_host(media_host)
            if found:
                return found

    fast_basket_number = basket_number_for_volume(volume)
    if 1 <= fast_basket_number <= max_basket:
        found = check_host(basket_host(fast_basket_number))
        if found:
            return found

    fallback_numbers = fallback_basket_numbers(volume, max_basket)
    for start in range(0, len(fallback_numbers), BASKET_BATCH_SIZE):
        basket_numbers = fallback_numbers[start : start + BASKET_BATCH_SIZE]
        probe_items = []

        for basket_number in basket_numbers:
            host = basket_host(basket_number)
            if host in checked_hosts:
                continue

            checked_hosts.add(host)
            base_url = build_base_url(article, host, size)
            probe_items.append((basket_number, build_probe_url(base_url, 1)))

        results = probe_many(probe_items, timeout=timeout, workers=workers, probe=probe)
        for basket_number in basket_numbers:
            result = results.get(basket_number)
            if result and result.exists:
                host = basket_host(basket_number)
                return BaseUrl(host=host, url=build_base_url(article, host, size))

    return None


def collect_image_urls(
    base_url: str,
    max_photos: int,
    timeout: float,
    workers: int,
    probe: Probe = probe_url_exists,
) -> list[str]:
    probe_items = [(image_number, build_probe_url(base_url, image_number)) for image_number in range(1, max_photos + 1)]
    results = probe_many(probe_items, timeout=timeout, workers=workers, probe=probe)

    return [build_probe_url(base_url, image_number) for image_number in range(1, max_photos + 1) if results[image_number].exists]


def resolve_article(
    article: int,
    basket_config: BasketConfig | None,
    max_photos: int,
    max_basket: int,
    timeout: float,
    workers: int,
    size: str,
    probe: Probe = probe_url_exists,
) -> dict[str, Any]:
    base_url = find_working_base_url(
        article=article,
        size=size,
        basket_config=basket_config,
        max_basket=max_basket,
        timeout=timeout,
        workers=workers,
        probe=probe,
    )

    if base_url is None:
        return {
            "status": "not_found",
            "host": None,
            "base_url": None,
            "image_urls": [],
        }

    return {
        "status": "ok",
        "host": base_url.host,
        "base_url": base_url.url,
        "image_urls": collect_image_urls(
            base_url=base_url.url,
            max_photos=max_photos,
            timeout=timeout,
            workers=workers,
            probe=probe,
        ),
    }


def resolve_articles(
    articles: Sequence[int],
    basket_config: BasketConfig | None,
    max_photos: int,
    max_basket: int,
    timeout: float,
    workers: int,
    size: str,
    probe: Probe = probe_url_exists,
) -> dict[str, dict[str, Any]]:
    return {
        str(article): resolve_article(
            article=article,
            basket_config=basket_config,
            max_photos=max_photos,
            max_basket=max_basket,
            timeout=timeout,
            workers=workers,
            size=size,
            probe=probe,
        )
        for article in articles
    }


def format_markdown(results: Mapping[str, Mapping[str, Any]]) -> str:
    lines = ["# WB Product Images", ""]

    for article, result in results.items():
        lines.append(f"## {article}")
        lines.append("")

        if result["status"] != "ok":
            lines.append("Status: not found by current image-CDN probe.")
            lines.append("")
            continue

        lines.append(f"Host: `{result['host']}`")
        lines.append("")
        for url in result["image_urls"]:
            lines.append(f"- {url}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")

    return parsed


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")

    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resolve live Wildberries image URLs from product_ids, nm_ids, SKUs, or article IDs.",
    )
    parser.add_argument("product_ids", nargs="*", help="WB product_id/nm_id/SKU values")
    parser.add_argument("--input-file", help="Read product IDs from a UTF-8 file, or '-' for stdin")
    parser.add_argument("--max-photos", type=positive_int, default=DEFAULT_MAX_PHOTOS)
    parser.add_argument("--max-basket", type=positive_int, default=DEFAULT_MAX_BASKET)
    parser.add_argument("--timeout", type=positive_float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--workers", type=positive_int, default=DEFAULT_WORKERS)
    parser.add_argument("--size", choices=("big", "tm"), default="big")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument("--basket-config", help="Optional JSON from the app-style misc/wb_baskets response")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        articles = load_article_ids(args.product_ids, args.input_file)
        basket_config = load_basket_config(args.basket_config)
        results = resolve_articles(
            articles=articles,
            basket_config=basket_config,
            max_photos=args.max_photos,
            max_basket=args.max_basket,
            timeout=args.timeout,
            workers=args.workers,
            size=args.size,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.exit(2, f"error: {error}\n")

    if args.format == "markdown":
        print(format_markdown(results), end="")
    else:
        print(json.dumps(results, ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
