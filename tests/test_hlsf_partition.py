import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hlsf_db_tools.partition import BIGRAMS, bigram_bucket, import_source_into_remote


def _write_sample_source(tmp_path: Path) -> Path:
    payload = {
        "tokens": [
            {
                "token": "alpha",
                "relationships": {
                    "rel1": [
                        {"token": "gamma", "weight": 0.7},
                        {"token": "beta", "weight": 0.9},
                    ],
                    "rel2": [
                        {"token": "theta", "weight": 0.5},
                        {"token": "eta", "weight": 0.5},
                    ],
                },
                "cached_at": "2025-11-16T00:00:00Z",
            },
            {
                "token": "beta",
                "relationships": {
                    "rel1": [
                        {"token": "alpha", "weight": 0.4},
                    ],
                },
                "cached_at": "2025-11-16T00:00:00Z",
            },
        ]
    }
    source = tmp_path / "source.json"
    source.write_text(json.dumps(payload), encoding="utf-8")
    return source


@pytest.mark.parametrize(
    "token, expected",
    [
        ("Alpha", ("A", "AL")),
        ("beta", ("B", "BE")),
        ("?hello", ("Z", "ZH")),
    ],
)
def test_bigram_bucket_handles_unicode_and_symbols(token: str, expected: tuple[str, str]) -> None:
    assert bigram_bucket(token) == expected


def test_import_source_into_remote_creates_expected_shards(tmp_path: Path) -> None:
    source = _write_sample_source(tmp_path)
    remote_root = tmp_path / "remote"

    import_source_into_remote(source, remote_root)

    alpha_shard = remote_root / "A" / "AL.json"
    beta_shard = remote_root / "B" / "BE.json"

    assert alpha_shard.exists(), "alpha should map to A/AL.json"
    assert beta_shard.exists(), "beta should map to B/BE.json"

    alpha_payload = json.loads(alpha_shard.read_text(encoding="utf-8"))
    beta_payload = json.loads(beta_shard.read_text(encoding="utf-8"))

    assert "alpha" in alpha_payload["tokens"], "alpha token should be stored in shard"
    assert "beta" in beta_payload["tokens"], "beta token should be stored in shard"

    rel1 = alpha_payload["tokens"]["alpha"]["relationships"]["rel1"]
    assert [edge["token"] for edge in rel1] == ["beta", "gamma"], "weights should sort descending"

    rel2 = alpha_payload["tokens"]["alpha"]["relationships"]["rel2"]
    assert rel2[0]["token"] == "eta", "ties should fall back to alphabetical token ordering"


def test_cli_dry_run_reports_token_totals(tmp_path: Path) -> None:
    source = _write_sample_source(tmp_path)
    remote_root = tmp_path / "remote"

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "hlsf_db_tools.partition",
            "--dry-run",
            "--source",
            str(source),
            "--remote-db",
            str(remote_root),
            "--log-level",
            "INFO",
        ],
        check=True,
        text=True,
        capture_output=True,
    )

    stdout = result.stdout.strip()
    combined = "\n".join([stdout, result.stderr.strip()])
    assert "tokens=2" in combined
    assert "populated_shards=" in combined


def test_cli_init_layout_creates_all_shards(tmp_path: Path) -> None:
    remote_root = tmp_path / "remote"

    subprocess.run(
        [sys.executable, "-m", "hlsf_db_tools.partition", "--init-layout", "--remote-db", str(remote_root)],
        check=True,
        capture_output=True,
        text=True,
    )

    expected = {remote_root / bg[0] / f"{bg}.json" for bg in BIGRAMS}
    assert all(path.exists() for path in expected)
