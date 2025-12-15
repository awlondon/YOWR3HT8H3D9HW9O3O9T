# Data Processing Utilities

The cognition engine relies on two small Python utilities to keep the token
graph synchronized between local development and hosted environments. This
short guide documents how to run them and what to expect from their outputs.

## `hlsf-partition`

```
hlsf-partition --source ./HLSF_Database_2025-10-26_INITIATION.json \
  --remote-db ./remote-db
```

* Creates the full 26×26 `remote-db/<letter>/<bigram>.json` layout if it does
  not exist.
* Imports tokens from the provided export and merges them with any existing
  shard files (idempotent). A `tqdm` progress bar renders when available; use
  `--log-interval` for minimal environments.
* Includes a `HLSFShardLoader` helper that can be imported by the runtime to
  fetch adjacency data for a token, enabling pre-prompt cache warmups.

### Common flags

| Flag | Description |
| ---- | ----------- |
| `--init-layout` | Only create the directory layout without importing data. |
| `--dry-run` | Scan the source file and report how many shards would receive new tokens. |
| `--fallback-letter` | Substitute character for tokens whose first glyph is not `[A-Z]`. |
| `--quiet` | Suppress non-error logs (overrides `--log-level`). |

## `hlsf-chunker`

```
hlsf-chunker \
  --source ./HLSF_Database_2025-10-23.json \
  --output-dir ./remote-db
```

* Splits the canonical export into small prefix-based chunk files under
  `remote-db/chunks/` so the UI can lazily fetch subsets of the graph.
* Writes a `metadata.json` manifest plus a flat `token-index.json` that helps
  auto-complete widgets locate specific tokens.
* Ships with documented helper functions (`group_tokens_by_prefix`,
  `process_database`, etc.) to simplify testing.
* Accepts `--log-interval` and `--quiet` to match the partition CLI behaviour.

> **Tip:** Delete or move the `remote-db/chunks` directory before running the
> script if you want a completely fresh dataset. The CLI already does this, but
> it is useful to know when troubleshooting cached data on a CDN.
