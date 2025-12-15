import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hlsf_db_tools import symbols
from hlsf_db_tools.chunker import (
    group_tokens_by_prefix,
    load_database,
    prefix_for_token,
    process_database,
)


def test_group_tokens_by_prefix_handles_numbers_and_symbols() -> None:
    tokens = [
        {"token": "Alpha"},
        {"token": "beta"},
        {"token": "3d-model"},
        {"token": "¡exclaim"},
    ]
    grouped = group_tokens_by_prefix(tokens)
    assert set(grouped.keys()) == {"a", "b", "3", "_"}


@pytest.mark.parametrize(
    "token, expected",
    [
        ("", "_"),
        ("Beta", "b"),
        ("7zip", "7"),
        ("#hash", "_"),
    ],
)
def test_prefix_for_token_varies_by_type(token: str, expected: str) -> None:
    assert prefix_for_token(token) == expected


def test_process_database_emits_chunks(tmp_path: Path) -> None:
    payload = {"full_token_data": [{"token": "alpha"}, {"token": "beta"}]}
    source = tmp_path / "db.json"
    source.write_text(json.dumps(payload), encoding="utf-8")

    output_dir = tmp_path / "out"
    count = process_database(source, output_dir, log=False)

    assert count == 3  # alpha + beta + symbols
    assert (output_dir / "chunks" / "a.json").exists()
    metadata = json.loads((output_dir / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["total_tokens"] is None or metadata["total_tokens"] >= 0


def test_load_database_raises_for_missing_or_invalid(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_database(tmp_path / "missing.json")

    invalid = tmp_path / "invalid.json"
    invalid.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError):
        load_database(invalid)


@pytest.mark.parametrize(
    "token, expected_prefix",
    [
        ("ßeta", "_"),
        ("Ωmega", "_"),
        ("中文", "_"),
        ("👍", "_"),
    ],
)
def test_group_tokens_by_prefix_handles_unicode(token: str, expected_prefix: str) -> None:
    grouped = group_tokens_by_prefix([{"token": token}])
    assert list(grouped.keys()) == [expected_prefix]


def test_symbol_list_flattens_without_duplicates() -> None:
    categories = symbols.load_symbol_categories()
    flattened = symbols.symbol_list(categories)
    assert len(flattened) == len(set(flattened))
    assert all(isinstance(ch, str) for ch in flattened)
