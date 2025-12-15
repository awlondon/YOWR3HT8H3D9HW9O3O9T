"""Partition and merge HLSF database exports into bigram shards."""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from hlsf_db_tools.symbols import SYMBOL_BUCKET

logger = logging.getLogger(__name__)

ALPHABET = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
BIGRAMS = [a + b for a in ALPHABET for b in ALPHABET]

DEFAULT_REMOTE_DB = os.environ.get("HLSF_REMOTE_DB", ".\\remote-db" if os.name == "nt" else "./remote-db")
DEFAULT_LOCAL_CACHE = os.environ.get("HLSF_LOCAL_CACHE", "./cache")
DEFAULT_SOURCE = os.environ.get("HLSF_SOURCE_JSON", "./HLSF_Database.json")


# ---------- Utilities

def now_iso() -> str:
    """Return a UTC ISO-8601 timestamp without microseconds."""

    import datetime as dt

    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_layout(root: Path) -> None:
    """Create the canonical 26×26 shard layout if it does not exist."""

    for a in ALPHABET:
        (root / a).mkdir(parents=True, exist_ok=True)
        for b in ALPHABET:
            shard = root / a / f"{a}{b}.json"
            if not shard.exists():
                shard.write_text(
                    json.dumps({"schema_version": 1, "updated_at": now_iso(), "tokens": {}}, ensure_ascii=False, indent=2)
                )


def normalize_token(token: str) -> str:
    """Lowercase, collapse whitespace, and trim the provided *token*."""

    normalized = (token or "").strip()
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def bigram_bucket(token: str, fallback_letter: str = "Z") -> Tuple[str, str]:
    """Return the folder letter (A–Z) and shard bigram (AA–ZZ) for *token*.

    Parameters
    ----------
    token:
        Raw token string. Non-alpha characters are mapped to *fallback_letter*.
    fallback_letter:
        Replacement uppercase letter for non-alphabetic leading characters.

    Returns
    -------
    tuple[str, str]
        (folder letter, bigram key)
    """

    tok = normalize_token(token).lower()

    def pick(index: int) -> str:
        if index < len(tok) and tok[index].isalpha():
            return tok[index].upper()
        return fallback_letter

    first = pick(0)
    second = pick(1)
    return first, first + second


def load_json(path: Path) -> Dict[str, Any]:
    """Load a shard JSON file, returning an empty structure if missing."""

    if not path.exists():
        return {"schema_version": 1, "updated_at": now_iso(), "tokens": {}}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def atomic_write(path: Path, obj: Any) -> None:
    """Write *obj* to *path* via an atomic rename."""

    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(obj, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---------- Merge strategy

def merge_relationship_lists(dst_list: List[Dict[str, Any]], src_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge two adjacency lists keyed by neighbor token.

    Parameters
    ----------
    dst_list, src_list:
        Arrays of objects shaped like ``{"token": str, "weight": number}``.

    Returns
    -------
    list[dict]
        New list containing one entry per neighbor token, keeping the maximum
        weight when the neighbor appears in both inputs. The output is sorted
        by descending weight and then alphabetically by token for tie-breaking.
    """

    by_tok = {edge["token"]: float(edge.get("weight", 0.0)) for edge in dst_list}
    for edge in src_list:
        token = edge.get("token")
        if not token:
            continue
        weight = float(edge.get("weight", 0.0))
        if token in by_tok:
            by_tok[token] = max(by_tok[token], weight)
        else:
            by_tok[token] = weight
    return [{"token": key, "weight": value} for key, value in sorted(by_tok.items(), key=lambda item: (-item[1], item[0]))]


def merge_token(dst_tok_obj: Dict[str, Any], src_tok_obj: Dict[str, Any]) -> Dict[str, Any]:
    """Combine two token payloads into a single record.

    The function unions relationship types and resolves conflicts by choosing
    the heaviest edge per neighbor. ``cached_at`` timestamps are preserved and
    the latest non-null value wins.

    Parameters
    ----------
    dst_tok_obj, src_tok_obj:
        Token dictionaries with ``relationships`` and optional ``cached_at``
        fields. Either value may be falsy to indicate a missing record.

    Returns
    -------
    dict
        Merged token object with normalized relationship lists.
    """

    out: Dict[str, Any] = {"relationships": {}, "cached_at": None}
    dst_rel = (dst_tok_obj or {}).get("relationships", {}) or {}
    src_rel = (src_tok_obj or {}).get("relationships", {}) or {}
    all_types = set(dst_rel.keys()) | set(src_rel.keys())
    for rel_type in all_types:
        out["relationships"][rel_type] = merge_relationship_lists(dst_rel.get(rel_type, []), src_rel.get(rel_type, []))
    cached_values: List[str] = [
        ts
        for ts in [dst_tok_obj.get("cached_at") if dst_tok_obj else None, src_tok_obj.get("cached_at") if src_tok_obj else None]
        if isinstance(ts, str)
    ]
    out["cached_at"] = max(cached_values, default=None)
    return out


def merge_shard(dst: Dict[str, Any], src: Dict[str, Any]) -> Dict[str, Any]:
    """Combine two shard payloads into an updated shard mapping."""

    merged: Dict[str, Any] = {"schema_version": 1, "updated_at": now_iso(), "tokens": {}}
    dst_tokens = (dst or {}).get("tokens", {}) or {}
    src_tokens = (src or {}).get("tokens", {}) or {}
    all_tokens = set(dst_tokens.keys()) | set(src_tokens.keys())
    for token in all_tokens:
        merged["tokens"][token] = merge_token(dst_tokens.get(token, {}), src_tokens.get(token, {}))
    return merged


# ---------- Importer

def to_shard_obj(entry: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Normalize a raw token entry into the shard schema."""

    token = normalize_token(entry.get("token", ""))
    if not token:
        return "", {}
    relationships = entry.get("relationships", {}) or {}
    cached_at = entry.get("cached_at")
    tok_obj = {"relationships": relationships, "cached_at": cached_at}
    return token, tok_obj


def _progress_iterator(sequence: Iterable[Any], total: int | None, log_interval: int) -> Iterable[Any]:
    """Yield from *sequence* with optional tqdm progress or interval logging."""

    try:
        from tqdm import tqdm
    except Exception:  # pragma: no cover - fallback path
        tqdm = None

    if tqdm:
        yield from tqdm(sequence, total=total, unit="token")
        return

    start = time.time()
    for index, item in enumerate(sequence, 1):
        if log_interval and index % log_interval == 0:
            elapsed = time.time() - start
            logger.info("processed %s tokens (%.2fs elapsed)", index, elapsed)
        yield item


def import_source_into_remote(
    source_json: Path,
    remote_root: Path,
    fallback_letter: str = "Z",
    log_interval: int = 0,
) -> None:
    """Merge a canonical DB export into the on-disk shard layout.

    The importer walks the exported token list, assigns each normalized token to
    a 26×26 shard bucket, and writes the merged shards atomically. When the
    optional ``tqdm`` dependency is available, a progress bar renders during the
    merge; otherwise the ``log_interval`` governs periodic log updates.

    Parameters
    ----------
    source_json:
        Path to the exported HLSF database JSON file.
    remote_root:
        Directory containing the shard layout; folders will be created as
        needed.
    fallback_letter:
        Replacement uppercase letter used when a token begins with a
        non-alphabetic character.
    log_interval:
        Emit progress logs every N tokens when ``tqdm`` is unavailable; set to
        0 to disable interval logging.

    Raises
    ------
    FileNotFoundError
        If ``source_json`` does not exist.
    json.JSONDecodeError
        If ``source_json`` contains invalid JSON.
    """

    ensure_layout(remote_root)
    with source_json.open("r", encoding="utf-8") as handle:
        src = json.load(handle)

    full = src.get("full_token_data") or src.get("tokens") or []
    count = 0

    accum: Dict[str, Dict[str, Any]] = {bg: {"schema_version": 1, "updated_at": now_iso(), "tokens": {}} for bg in BIGRAMS}

    log_every = max(0, int(log_interval))
    for entry in _progress_iterator(full, total=len(full) or None, log_interval=log_every):
        token, tok_obj = to_shard_obj(entry)
        if not tok_obj:
            continue
        folder, bigram = bigram_bucket(token, fallback_letter=fallback_letter)
        shard_key = bigram
        accum[shard_key]["tokens"][token] = merge_token(accum[shard_key]["tokens"].get(token, {}), tok_obj)
        count += 1
        if folder == SYMBOL_BUCKET.upper():
            logger.debug("symbol token %s routed to %s", token, shard_key)

    for a in ALPHABET:
        for b in ALPHABET:
            shard_name = a + b
            shard_path = remote_root / a / f"{shard_name}.json"
            on_disk = load_json(shard_path)
            merged = merge_shard(on_disk, accum[shard_name])
            atomic_write(shard_path, merged)

    logger.info("merged %s tokens into %s", count, remote_root)


# ---------- Runtime loader (for “pre-prompt” fetches)
class HLSFShardLoader:
    """Lightweight accessor for adjacency data during prompting."""

    def __init__(self, remote_root: str = DEFAULT_REMOTE_DB, local_cache: str = DEFAULT_LOCAL_CACHE, fallback_letter: str = "Z"):
        self.remote = Path(remote_root)
        self.cache = Path(local_cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.fallback = fallback_letter
        ensure_layout(self.remote)
        self._mem: Dict[str, Dict[str, Any]] = {}

    def shard_path(self, bigram: str) -> Path:
        """Return the filesystem path for *bigram* shard."""

        return self.remote / bigram[0] / f"{bigram}.json"

    def _load_shard(self, bigram: str) -> Dict[str, Any]:
        if bigram in self._mem:
            return self._mem[bigram]
        path = self.shard_path(bigram)
        data = load_json(path)
        self._mem[bigram] = data
        return data

    def preload_for_input(self, user_input: str) -> Dict[str, Any]:
        """Load and cache the shard corresponding to the first token in *user_input*."""

        token = normalize_token(next(iter(re.findall(r"[A-Za-z][A-Za-z0-9_\- ]*", user_input)), ""))
        _, bigram = bigram_bucket(token, fallback_letter=self.fallback)
        return self._load_shard(bigram)

    def adjacency_for_token(self, token: str) -> Dict[str, Any]:
        """Return the adjacency map for *token* from its shard.

        Parameters
        ----------
        token:
            Raw token string to fetch.

        Returns
        -------
        dict[str, Any]
            Token entry with ``relationships`` and ``cached_at`` keys. If the
            token is unknown, an empty adjacency structure is returned.
        """

        normalized = normalize_token(token)
        _, bigram = bigram_bucket(normalized, fallback_letter=self.fallback)
        shard = self._load_shard(bigram)
        return shard.get("tokens", {}).get(normalized, {"relationships": {}, "cached_at": None})


# ---------- CLI

def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI parser for the partition tool."""

    parser = argparse.ArgumentParser(description="HLSF DB importer/merger and shard builder.")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="Path to HLSF source JSON export.")
    parser.add_argument("--remote-db", default=DEFAULT_REMOTE_DB, help="Path to remote-db root (26 folders).")
    parser.add_argument("--local-cache", default=DEFAULT_LOCAL_CACHE, help="Path to local cache dir (unused for write, reserved for runtime).")
    parser.add_argument("--fallback-letter", default="Z", choices=ALPHABET, help="Fallback letter for non-alpha characters in token bigram mapping.")
    parser.add_argument("--init-layout", action="store_true", help="Only create the 26x26 layout and exit.")
    parser.add_argument("--dry-run", action="store_true", help="Parse source, map bigrams, but don't write.")
    parser.add_argument("--log-interval", type=int, default=0, help="Log progress every N tokens when tqdm is unavailable (0 disables interval logging).")
    parser.add_argument("--log-level", default="INFO", help="Logging level (e.g., DEBUG, INFO, WARNING).")
    parser.add_argument("--quiet", action="store_true", help="Suppress non-error logs (overrides --log-level).")
    return parser


def main(argv: List[str] | None = None) -> int:
    """Entry point for the hlsf-partition CLI."""

    parser = build_parser()
    args = parser.parse_args(argv)

    log_level = logging.ERROR if args.quiet else getattr(logging, str(args.log_level).upper(), logging.INFO)
    logging.basicConfig(level=log_level, format="%(levelname)s %(message)s")

    remote_root = Path(args.remote_db)
    remote_root.mkdir(parents=True, exist_ok=True)

    if args.init_layout:
        ensure_layout(remote_root)
        logger.info("initialized 26x26 layout under %s", remote_root)
        return 0

    source = Path(args.source)
    if not source.exists():
        logger.error("source file missing: %s", source)
        return 2

    ensure_layout(remote_root)

    if args.dry_run:
        with source.open("r", encoding="utf-8") as handle:
            src = json.load(handle)
        full = src.get("full_token_data") or src.get("tokens") or []
        counts = {bg: 0 for bg in BIGRAMS}
        for entry in full:
            token = normalize_token(entry.get("token", ""))
            if not token:
                continue
            _, bg = bigram_bucket(token, fallback_letter=args.fallback_letter)
            counts[bg] += 1
        total = sum(counts.values())
        nonzero = sum(1 for value in counts.values() if value > 0)
        logger.info("tokens=%s, populated_shards=%s/676", total, nonzero)
        return 0

    import_source_into_remote(source, remote_root, fallback_letter=args.fallback_letter, log_interval=max(0, int(args.log_interval or 0)))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI passthrough
    raise SystemExit(main())
