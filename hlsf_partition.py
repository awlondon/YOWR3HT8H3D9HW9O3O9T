#!/usr/bin/env python3
"""Compatibility shim for the hlsf_db_tools.partition CLI."""
from __future__ import annotations

from hlsf_db_tools.partition import *  # noqa: F401,F403
from hlsf_db_tools.partition import main


if __name__ == "__main__":  # pragma: no cover - CLI passthrough
    raise SystemExit(main())
