"""Chunk the canonical HLSF database export into prefix-based JSON files."""
from __future__ import annotations

import argparse
import json
import logging
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Mapping, MutableMapping, Sequence, cast

from hlsf_db_tools.symbols import SYMBOL_BUCKET, load_symbol_categories, symbol_list

logger = logging.getLogger(__name__)

DEFAULT_DB_FILENAME = "HLSF_Database_2025-10-23.json"
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "remote-db"


def prefix_for_token(token: str) -> str:
    """Return the normalized single-character chunk prefix for *token*."""

    if not token:
        return "_"
    first = token[0]
    if first.isascii() and first.isalpha():
        return first.lower()
    if first.isdigit():
        return first
    return "_"


def group_tokens_by_prefix(tokens: Iterable[Mapping[str, object]]) -> Dict[str, List[dict]]:
    """Group exported tokens by their prefix for chunk generation."""

    grouped: Dict[str, List[dict]] = defaultdict(list)
    for entry in tokens:
        token = str(entry.get("token", ""))
        prefix = prefix_for_token(token)
        grouped[prefix].append(dict(entry))
    return grouped


def remove_existing_chunks(chunks_dir: Path) -> None:
    """Clear stale chunk files to guarantee deterministic output."""

    if not chunks_dir.exists():
        chunks_dir.mkdir(parents=True, exist_ok=True)
        return
    for existing_file in chunks_dir.glob("*.json"):
        existing_file.unlink()


def write_chunk_files(grouped_tokens: Mapping[str, Sequence[Mapping[str, object]]], chunks_dir: Path) -> List[dict]:
    """Persist each prefix chunk and return the metadata entries."""

    chunk_entries: List[dict] = []
    for prefix in sorted(grouped_tokens.keys()):
        tokens = sorted(grouped_tokens[prefix], key=lambda item: str(item.get("token", "")))
        chunk_path = chunks_dir / f"{prefix}.json"
        chunk_data = {"prefix": prefix, "token_count": len(tokens), "tokens": tokens}
        chunk_path.write_text(json.dumps(chunk_data, ensure_ascii=False, indent=2))
        chunk_entries.append({"prefix": prefix, "href": f"chunks/{chunk_path.name}", "token_count": len(tokens)})
    return chunk_entries


def write_symbol_chunk(chunks_dir: Path) -> dict:
    """Create the static chunk for punctuation/symbol tokens."""

    categories = load_symbol_categories()
    symbol_entries = [{"token": token, "kind": "sym"} for token in symbol_list(categories)]
    symbol_chunk_path = chunks_dir / f"{SYMBOL_BUCKET}.json"
    symbol_chunk_data = {"prefix": SYMBOL_BUCKET, "token_count": len(symbol_entries), "tokens": symbol_entries}
    symbol_chunk_path.write_text(json.dumps(symbol_chunk_data, ensure_ascii=False, indent=2))
    return {"prefix": SYMBOL_BUCKET, "href": f"chunks/{symbol_chunk_path.name}", "token_count": len(symbol_entries)}


def load_database(db_path: Path) -> Dict[str, Any]:
    """Load and validate the canonical HLSF database export."""

    if not db_path.exists():
        raise FileNotFoundError(f"Database file not found: {db_path}")
    data = json.loads(db_path.read_text())
    if not data.get("full_token_data"):
        raise ValueError("No token data found in database export")
    return data


def write_metadata(
    data: MutableMapping[str, Any],
    chunk_entries: Sequence[Mapping[str, object]],
    output_dir: Path,
    source_name: str,
) -> None:
    """Record chunk manifest metadata and the flat token index."""

    metadata = {
        "version": data.get("readme", {}).get("version") or "2.1",
        "generated_at": data.get("export_timestamp"),
        "source": source_name,
        "total_tokens": data.get("database_stats", {}).get("total_tokens"),
        "total_relationships": data.get("database_stats", {}).get("total_relationships"),
        "chunk_prefix_length": 1,
        "chunks": list(chunk_entries),
        "token_index_href": "token-index.json",
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))

    full_token_data = data.get("full_token_data", [])
    token_index = {"tokens": sorted((entry.get("token", "") for entry in full_token_data), key=str.casefold)}
    (output_dir / "token-index.json").write_text(json.dumps(token_index, ensure_ascii=False, indent=2))


def _progress_iterator(sequence: Iterable[Any], total: int | None, log_interval: int) -> Iterator[Any]:
    """Yield from *sequence* while reporting progress.

    If :mod:`tqdm` is available, it is used to render a progress bar. Otherwise,
    periodic log messages are emitted according to ``log_interval``.
    """

    try:
        from tqdm import tqdm
    except Exception:  # pragma: no cover - fallback path when tqdm is missing
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


def process_database(source: Path, output_dir: Path, log: bool = True, *, log_interval: int = 0) -> int:
    """Load *source* and emit chunk files into *output_dir*.

    Parameters
    ----------
    source:
        Path to the canonical HLSF database export.
    output_dir:
        Target directory that will receive ``metadata.json`` and ``chunks/*.json``.
    log:
        Whether to emit informational log output during processing.
    log_interval:
        Emit progress logs every N tokens when ``tqdm`` is unavailable.

    Returns
    -------
    int
        Number of generated chunk files including the symbol chunk.
    """

    data = load_database(source)
    full_token_data = cast(Sequence[Mapping[str, Any]], data["full_token_data"])

    chunks_dir = output_dir / "chunks"
    remove_existing_chunks(chunks_dir)

    grouped_tokens: Dict[str, List[Mapping[str, object]]] = defaultdict(list)
    total_tokens = len(full_token_data) if hasattr(full_token_data, "__len__") else None
    for entry in _progress_iterator(full_token_data, total=total_tokens, log_interval=log_interval):
        token = str(entry.get("token", ""))
        prefix = prefix_for_token(token)
        grouped_tokens[prefix].append(dict(entry))

    chunk_entries = write_chunk_files(grouped_tokens, chunks_dir)
    chunk_entries.append(write_symbol_chunk(chunks_dir))
    write_metadata(data, chunk_entries, output_dir, source.name)

    if log:
        logger.info("wrote %s chunk files into %s", len(chunk_entries), chunks_dir)
    return len(chunk_entries)


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI parser for the chunker utility."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(REPO_ROOT / DEFAULT_DB_FILENAME), help="Path to the exported HLSF database JSON file.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Directory that will receive metadata.json, token-index.json, and chunk files.")
    parser.add_argument("--log-level", default="INFO", help="Logging level (e.g., DEBUG, INFO, WARNING).")
    parser.add_argument("--quiet", action="store_true", help="Suppress non-error logs (overrides --log-level).")
    parser.add_argument("--log-interval", type=int, default=0, help="Log progress every N tokens when tqdm is unavailable.")
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry-point for chunk generation."""

    parser = build_parser()
    args = parser.parse_args(argv)
    log_level = logging.ERROR if args.quiet else getattr(logging, str(args.log_level).upper(), logging.INFO)
    logging.basicConfig(level=log_level, format="%(levelname)s %(message)s")

    source = Path(args.source)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    chunk_count = process_database(source, output_dir, log=not args.quiet, log_interval=max(0, int(args.log_interval or 0)))
    return 0 if chunk_count >= 0 else 1


if __name__ == "__main__":  # pragma: no cover - CLI passthrough
    raise SystemExit(main())
