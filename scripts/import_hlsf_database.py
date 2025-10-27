#!/usr/bin/env python3
"""Compatibility wrapper for the hlsf_partition CLI.

This script delegates to :mod:`hlsf_partition` so existing automation can
continue invoking ``python scripts/import_hlsf_database.py`` while the new
bigram sharding pipeline lives at the repository root.
"""
from __future__ import annotations

import sys

from hlsf_partition import main


def run() -> int:
    """Execute the canonical importer CLI."""

    main()
    return 0


if __name__ == "__main__":
    sys.exit(run())
