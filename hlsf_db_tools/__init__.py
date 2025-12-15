"""Utility tools for partitioning and chunking HLSF database exports."""

from importlib.metadata import PackageNotFoundError, version

try:  # pragma: no cover - defensive
    __version__ = version("hlsf_db_tools")
except PackageNotFoundError:  # pragma: no cover - during editable installs
    __version__ = "0.0.0"

__all__ = ["__version__"]
