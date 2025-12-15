"""Shared symbol metadata for HLSF tooling."""
from __future__ import annotations

import json
from importlib import resources
from typing import Dict, Iterable, List, Mapping

SYMBOL_BUCKET = "symbols"


def load_symbol_categories() -> Dict[str, List[str]]:
    """Return the JSON-defined symbol categories.

    Raises
    ------
    FileNotFoundError
        If the embedded JSON resource cannot be found.
    json.JSONDecodeError
        If the JSON cannot be parsed.
    """

    with resources.files(__package__).joinpath("data/symbols.json").open("r", encoding="utf-8") as handle:
        return json.load(handle)


def symbol_list(categories: Mapping[str, Iterable[str]] | None = None) -> List[str]:
    """Flatten symbol *categories* into an ordered list.

    Parameters
    ----------
    categories:
        Optional mapping of category names to iterables of symbol strings.
        When omitted the embedded symbol categories are loaded.

    Returns
    -------
    list[str]
        All unique symbols, preserving the category order then the order
        provided inside each category list.
    """

    data = categories or load_symbol_categories()
    seen: set[str] = set()
    symbols: List[str] = []
    for category in data.values():
        for symbol in category:
            if symbol not in seen:
                seen.add(symbol)
                symbols.append(symbol)
    return symbols


__all__ = ["SYMBOL_BUCKET", "load_symbol_categories", "symbol_list"]
