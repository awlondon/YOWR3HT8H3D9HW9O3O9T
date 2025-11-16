#!/usr/bin/env python3
"""
HLSF shard builder & remote-db merger
- Creates a 26x26 bigram shard layout: ./remote-db/A/AA.json ... ./remote-db/Z/ZZ.json
- Imports a source HLSF DB export JSON
- Merges into existing remote-db shards (idempotent)
- Provides a tiny runtime loader for pre-prompt adjacency mapping

Schema per-shard file:
{
  "schema_version": 1,
  "updated_at": "ISO8601",
  "tokens": {
    "<token>": {
      "relationships": {
        "<rel_symbol>": [{"token": "<other>", "weight": <float>}, ...],
        ...
      },
      "cached_at": "ISO8601" | null
    },
    ...
  }
}
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Any, Tuple

ALPHABET = [chr(c) for c in range(ord('A'), ord('Z')+1)]
BIGRAMS = [a+b for a in ALPHABET for b in ALPHABET]

# Defaults (override via CLI/env)
DEFAULT_REMOTE_DB = os.environ.get(
    "HLSF_REMOTE_DB",
    ".\\remote-db" if os.name == "nt" else "./remote-db",
)
DEFAULT_LOCAL_CACHE = os.environ.get("HLSF_LOCAL_CACHE", "./cache")
DEFAULT_SOURCE = os.environ.get("HLSF_SOURCE_JSON", "./HLSF_Database.json")

# ---------- Utilities

def now_iso() -> str:
    import datetime as dt
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def ensure_layout(root: Path) -> None:
    """Create the canonical 26×26 shard layout if it does not exist."""

    for a in ALPHABET:
        (root / a).mkdir(parents=True, exist_ok=True)
        for b in ALPHABET:
            shard = root / a / f"{a}{b}.json"
            if not shard.exists():
                shard.write_text(json.dumps({
                    "schema_version": 1,
                    "updated_at": now_iso(),
                    "tokens": {}
                }, ensure_ascii=False, indent=2))

def normalize_token(t: str) -> str:
    """Lowercase, collapse whitespace, and trim the provided token."""

    t = (t or "").strip()
    t = re.sub(r"\s+", " ", t)
    return t

def bigram_bucket(token: str, fallback_letter: str = "Z") -> Tuple[str, str]:
    """
    Returns folder letter (A–Z) and shard bigram (AA–ZZ).
    Non [A-Z] characters map to fallback_letter.
    """
    tok = normalize_token(token).lower()
    def pick(i: int) -> str:
        if i < len(tok) and tok[i].isalpha():
            return tok[i].upper()
        return fallback_letter
    a = pick(0)
    b = pick(1)
    return a, a + b

def load_json(path: Path) -> Dict[str, Any]:
    """Load a shard JSON file, returning an empty structure if missing."""

    if not path.exists():
        return {"schema_version": 1, "updated_at": now_iso(), "tokens": {}}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)

def atomic_write(path: Path, obj: Any) -> None:
    """Write *obj* to *path* via an atomic rename."""

    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

# ---------- Merge strategy

def merge_relationship_lists(dst_list: List[Dict[str, Any]], src_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Merge edge arrays by neighbor token; keep the max weight for a given neighbor.
    """
    by_tok = {e["token"]: float(e.get("weight", 0.0)) for e in dst_list}
    for e in src_list:
        tok = e.get("token")
        if not tok:
            continue
        w = float(e.get("weight", 0.0))
        if tok in by_tok:
            by_tok[tok] = max(by_tok[tok], w)
        else:
            by_tok[tok] = w
    return [{"token": k, "weight": v} for k, v in sorted(by_tok.items(), key=lambda kv: (-kv[1], kv[0]))]

def merge_token(dst_tok_obj: Dict[str, Any], src_tok_obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Merge token objects: union of relationship types; max weight per neighbor; latest cached_at.
    """
    out = {"relationships": {}, "cached_at": None}
    dst_rel = (dst_tok_obj or {}).get("relationships", {}) or {}
    src_rel = (src_tok_obj or {}).get("relationships", {}) or {}
    all_types = set(dst_rel.keys()) | set(src_rel.keys())
    for t in all_types:
        out["relationships"][t] = merge_relationship_lists(dst_rel.get(t, []), src_rel.get(t, []))
    # cached_at: prefer the more recent if available
    d_ca = (dst_tok_obj or {}).get("cached_at")
    s_ca = (src_tok_obj or {}).get("cached_at")
    out["cached_at"] = max([x for x in [d_ca, s_ca] if x], default=None)
    return out

def merge_shard(dst: Dict[str, Any], src: Dict[str, Any]) -> Dict[str, Any]:
    out = {
        "schema_version": 1,
        "updated_at": now_iso(),
        "tokens": {}
    }
    dst_tokens = (dst or {}).get("tokens", {}) or {}
    src_tokens = (src or {}).get("tokens", {}) or {}
    all_tokens = set(dst_tokens.keys()) | set(src_tokens.keys())
    for tok in all_tokens:
        out["tokens"][tok] = merge_token(dst_tokens.get(tok), src_tokens.get(tok))
    return out

# ---------- Importer

def to_shard_obj(entry: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Normalize a raw token entry into the shard schema."""

    tok = normalize_token(entry.get("token", ""))
    if not tok:
        return "", {}
    relationships = entry.get("relationships", {}) or {}
    cached_at = entry.get("cached_at")
    tok_obj = {"relationships": relationships, "cached_at": cached_at}
    return tok, tok_obj

def import_source_into_remote(source_json: Path, remote_root: Path, fallback_letter: str = "Z") -> None:
    """Merge a canonical DB export into the on-disk shard layout."""

    ensure_layout(remote_root)
    with source_json.open("r", encoding="utf-8") as f:
        src = json.load(f)

    full = src.get("full_token_data") or src.get("tokens") or []
    count = 0

    # build an in-memory accumulator of shards to reduce IO churn
    accum: Dict[str, Dict[str, Any]] = {bg: {"schema_version": 1, "updated_at": now_iso(), "tokens": {}} for bg in BIGRAMS}

    for entry in full:
        tok, tok_obj = to_shard_obj(entry)
        if not tok_obj:
            continue
        folder, bigram = bigram_bucket(tok, fallback_letter=fallback_letter)
        shard_key = bigram  # AA..ZZ
        accum[shard_key]["tokens"][tok] = merge_token(accum[shard_key]["tokens"].get(tok, {}), tok_obj)
        count += 1

    # merge accum into disk shards
    for a in ALPHABET:
        for b in ALPHABET:
            shard_name = a + b
            shard_path = remote_root / a / f"{shard_name}.json"
            on_disk = load_json(shard_path)
            merged = merge_shard(on_disk, accum[shard_name])
            atomic_write(shard_path, merged)

    print(f"[import] merged {count} tokens into {remote_root}")

# ---------- Runtime loader (for “pre-prompt” fetches)

class HLSFShardLoader:
    def __init__(self, remote_root: str = DEFAULT_REMOTE_DB, local_cache: str = DEFAULT_LOCAL_CACHE, fallback_letter: str = "Z"):
        self.remote = Path(remote_root)
        self.cache = Path(local_cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.fallback = fallback_letter
        ensure_layout(self.remote)

        # simple in-memory cache: bigram -> dict
        self._mem: Dict[str, Dict[str, Any]] = {}

    def shard_path(self, bigram: str) -> Path:
        return self.remote / bigram[0] / f"{bigram}.json"

    def _load_shard(self, bigram: str) -> Dict[str, Any]:
        if bigram in self._mem:
            return self._mem[bigram]
        path = self.shard_path(bigram)
        data = load_json(path)
        self._mem[bigram] = data
        return data

    def preload_for_input(self, user_input: str) -> Dict[str, Any]:
        """
        Call this the moment the user types anything (pre-prompt).
        We take the first token-ish sequence and load its shard.
        """
        # crude "first token" grab:
        token = normalize_token(next(iter(re.findall(r"[A-Za-z][A-Za-z0-9_\- ]*", user_input)) , ""))
        folder, bigram = bigram_bucket(token, fallback_letter=self.fallback)
        return self._load_shard(bigram)

    def adjacency_for_token(self, token: str) -> Dict[str, Any]:
        token = normalize_token(token)
        _, bigram = bigram_bucket(token, fallback_letter=self.fallback)
        shard = self._load_shard(bigram)
        return shard.get("tokens", {}).get(token, {"relationships": {}, "cached_at": None})

# ---------- CLI

def main():
    ap = argparse.ArgumentParser(description="HLSF DB importer/merger and shard builder.")
    ap.add_argument("--source", default=DEFAULT_SOURCE, help="Path to HLSF source JSON export.")
    ap.add_argument("--remote-db", default=DEFAULT_REMOTE_DB, help="Path to remote-db root (26 folders).")
    ap.add_argument("--local-cache", default=DEFAULT_LOCAL_CACHE, help="Path to local cache dir (unused for write, reserved for runtime).")
    ap.add_argument("--fallback-letter", default="Z", choices=ALPHABET, help="Fallback letter for non-alpha characters in token bigram mapping.")
    ap.add_argument("--init-layout", action="store_true", help="Only create the 26x26 layout and exit.")
    ap.add_argument("--dry-run", action="store_true", help="Parse source, map bigrams, but don't write.")
    args = ap.parse_args()

    remote_root = Path(args.remote_db)
    remote_root.mkdir(parents=True, exist_ok=True)

    if args.init_layout:
        ensure_layout(remote_root)
        print(f"[layout] initialized 26x26 under {remote_root}")
        return

    source = Path(args.source)
    if not source.exists():
        print(f"[error] source file missing: {source}", file=sys.stderr)
        sys.exit(2)

    ensure_layout(remote_root)

    if args.dry_run:
        # Load and map just to validate
        with source.open("r", encoding="utf-8") as f:
            src = json.load(f)
        full = src.get("full_token_data") or src.get("tokens") or []
        counts = {bg: 0 for bg in BIGRAMS}
        for entry in full:
            tok = normalize_token(entry.get("token", ""))
            if not tok:
                continue
            _, bg = bigram_bucket(tok, fallback_letter=args.fallback_letter)
            counts[bg] += 1
        total = sum(counts.values())
        nonzero = sum(1 for v in counts.values() if v > 0)
        print(f"[dry-run] tokens={total}, populated_shards={nonzero}/676")
        return

    import_source_into_remote(source, remote_root, fallback_letter=args.fallback_letter)

if __name__ == "__main__":
    main()
