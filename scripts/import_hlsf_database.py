"""Utility script for distributing HLSF databases into fuzzy-search pair shards.

The script accepts an exported HLSF database JSON file and writes a directory of
JSON files for each consonant/vowel two-letter pairing (AA through ZZ). Each file
contains the subset of token records whose normalized token names begin with the
corresponding pair, allowing for fast fuzzy lookups.
"""

from __future__ import annotations

import argparse
import json
import string
import sys
import unicodedata
from itertools import product
from pathlib import Path
from typing import Dict, Iterable, List, MutableMapping, Optional, Tuple

PAIR_ALPHABET = string.ascii_uppercase
PAIR_COMBINATIONS: Tuple[str, ...] = tuple(
    f"{first}{second}" for first, second in product(PAIR_ALPHABET, repeat=2)
)


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    """Parse command line arguments for the importer script."""

    parser = argparse.ArgumentParser(
        description=(
            "Distribute an HLSF database export into JSON files keyed by two-letter "
            "fuzzy-search pairs."
        )
    )
    parser.add_argument(
        "input",
        type=Path,
        help="Path to the HLSF database export JSON file.",
    )
    parser.add_argument(
        "output",
        type=Path,
        help=(
            "Directory where the pair-distributed JSON files will be written. "
            "The directory will be created if it does not exist."
        ),
    )
    parser.add_argument(
        "--copy-metadata",
        action="store_true",
        help=(
            "When provided, the script writes a metadata.json file containing the "
            "top-level metadata from the HLSF export."
        ),
    )

    return parser.parse_args(argv)


def load_database(input_path: Path) -> MutableMapping[str, object]:
    """Load the HLSF database export from disk."""

    if not input_path.exists():
        raise FileNotFoundError(f"Database export not found: {input_path}")

    with input_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize_token_name(token_name: str) -> str:
    """Normalize token text into an ASCII-only uppercase string."""

    normalized = unicodedata.normalize("NFKD", token_name)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    letters = [char for char in ascii_only if char in string.ascii_letters]
    return "".join(letters).upper()


def pair_from_token(token_name: str) -> Optional[str]:
    """Derive the two-character fuzzy pair for a token."""

    normalized = normalize_token_name(token_name)
    if len(normalized) >= 2:
        return normalized[:2]
    if len(normalized) == 1:
        return normalized * 2
    return None


def ensure_output_dir(output_dir: Path) -> None:
    """Create the output directory if it does not already exist."""

    output_dir.mkdir(parents=True, exist_ok=True)


def initialise_buckets() -> Dict[str, List[dict]]:
    """Create an empty list bucket for every two-letter combination."""

    return {pair: [] for pair in PAIR_COMBINATIONS}


def bucket_tokens(
    token_records: Iterable[MutableMapping[str, object]],
) -> Tuple[
    Dict[str, List[MutableMapping[str, object]]],
    List[MutableMapping[str, object]],
]:
    """Bucket token records into their matching pair lists."""

    buckets = initialise_buckets()
    misc_bucket: List[MutableMapping[str, object]] = []

    for entry in token_records:
        token_name = str(entry.get("token", ""))
        pair_key = pair_from_token(token_name)
        if pair_key and pair_key in buckets:
            buckets[pair_key].append(entry)
        else:
            misc_bucket.append(entry)

    return buckets, misc_bucket


def write_pair_files(output_dir: Path, buckets: Dict[str, List[MutableMapping[str, object]]]) -> Dict[str, int]:
    """Write each pair bucket to its own JSON file and return counts."""

    counts: Dict[str, int] = {}
    for pair_key, records in buckets.items():
        records_sorted = sorted(records, key=lambda item: str(item.get("token", "")).lower())
        payload = {"pair": pair_key, "tokens": records_sorted}
        output_path = output_dir / f"{pair_key}.json"
        with output_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        counts[pair_key] = len(records_sorted)
    return counts


def write_misc_file(output_dir: Path, misc_records: List[MutableMapping[str, object]]) -> Optional[int]:
    """Write tokens without valid pairs into a dedicated file."""

    if not misc_records:
        return None

    output_path = output_dir / "misc.json"
    sorted_records = sorted(misc_records, key=lambda item: str(item.get("token", "")).lower())
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump({"pair": None, "tokens": sorted_records}, handle, ensure_ascii=False, indent=2)
    return len(sorted_records)


def write_index_file(output_dir: Path, counts: Dict[str, int], misc_count: Optional[int], total_tokens: int) -> None:
    """Create an index.json summarising the pair distribution."""

    index_payload = {
        "total_pairs": len(counts),
        "total_tokens": total_tokens,
        "pairs": counts,
    }
    if misc_count is not None:
        index_payload["misc"] = misc_count

    output_path = output_dir / "index.json"
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(index_payload, handle, ensure_ascii=False, indent=2)


def maybe_write_metadata(output_dir: Path, database: MutableMapping[str, object]) -> None:
    """Persist the top-level metadata from the export if requested."""

    metadata = {
        key: database[key]
        for key in ["export_timestamp", "readme", "database_stats", "knowledge_graph_metrics"]
        if key in database
    }
    if not metadata:
        return

    output_path = output_dir / "metadata.json"
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=2)


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = parse_args(argv)
    database = load_database(args.input)

    token_records = database.get("full_token_data")
    if not isinstance(token_records, list):
        raise ValueError("The provided database export does not contain 'full_token_data'.")

    ensure_output_dir(args.output)
    buckets, misc_records = bucket_tokens(token_records)
    counts = write_pair_files(args.output, buckets)
    misc_count = write_misc_file(args.output, misc_records)
    total_tokens = len(token_records)
    write_index_file(args.output, counts, misc_count, total_tokens)

    if args.copy_metadata:
        maybe_write_metadata(args.output, database)

    print(
        f"Distributed {total_tokens} tokens across {len(counts)} pair files"
        + (f" with {misc_count} misc tokens" if misc_count else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
