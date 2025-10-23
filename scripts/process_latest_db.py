import json
from collections import defaultdict
from pathlib import Path

DB_FILENAME = "HLSF_Database_2025-10-23.json"
REPO_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = REPO_ROOT / DB_FILENAME
OUTPUT_DIR = REPO_ROOT / "remote-db"
CHUNKS_DIR = OUTPUT_DIR / "chunks"

if not DB_PATH.exists():
    raise FileNotFoundError(f"Database file not found: {DB_PATH}")

data = json.loads(DB_PATH.read_text())

full_token_data = data.get("full_token_data", [])
if not full_token_data:
    raise ValueError("No token data found in database export")

def prefix_for_token(token: str) -> str:
    if not token:
        return "_"
    first = token[0]
    if first.isalpha():
        return first.lower()
    if first.isdigit():
        return first
    return "_"

grouped_tokens: dict[str, list[dict]] = defaultdict(list)
for entry in full_token_data:
    token = entry.get("token", "")
    prefix = prefix_for_token(token)
    grouped_tokens[prefix].append(entry)

# remove existing chunks to avoid stale files
if CHUNKS_DIR.exists():
    for existing_file in CHUNKS_DIR.glob("*.json"):
        existing_file.unlink()
else:
    CHUNKS_DIR.mkdir(parents=True)

chunk_entries = []

for prefix in sorted(grouped_tokens.keys()):
    tokens = sorted(grouped_tokens[prefix], key=lambda item: item.get("token", ""))
    chunk_path = CHUNKS_DIR / f"{prefix}.json"
    chunk_data = {
        "prefix": prefix,
        "token_count": len(tokens),
        "tokens": tokens,
    }
    chunk_path.write_text(json.dumps(chunk_data, ensure_ascii=False, indent=2))
    chunk_entries.append({
        "prefix": prefix,
        "href": f"chunks/{chunk_path.name}",
        "token_count": len(tokens),
    })

metadata = {
    "version": data.get("readme", {}).get("version"),
    "generated_at": data.get("export_timestamp"),
    "source": DB_FILENAME,
    "total_tokens": data.get("database_stats", {}).get("total_tokens"),
    "total_relationships": data.get("database_stats", {}).get("total_relationships"),
    "chunk_prefix_length": 1,
    "chunks": chunk_entries,
    "token_index_href": "token-index.json",
}

(OUTPUT_DIR / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))

token_index = {
    "tokens": sorted((entry.get("token", "") for entry in full_token_data), key=str.casefold),
}

(OUTPUT_DIR / "token-index.json").write_text(json.dumps(token_index, ensure_ascii=False, indent=2))

