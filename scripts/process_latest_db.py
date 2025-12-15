"""Compatibility wrapper delegating to :mod:`hlsf_db_tools.chunker`."""
from __future__ import annotations

from hlsf_db_tools.chunker import main


if __name__ == "__main__":  # pragma: no cover - CLI passthrough
    raise SystemExit(main())
