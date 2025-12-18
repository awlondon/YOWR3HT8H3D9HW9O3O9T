"""Shared adjacency family classification used by exporters and tooling."""

from __future__ import annotations

from enum import Enum


class AdjacencyFamily(str, Enum):
    SPATIAL = "spatial"
    TEMPORAL = "temporal"
    CAUSAL = "causal"
    HIERARCHICAL = "hierarchical"
    ANALOGICAL = "analogical"
    CONSTRAINT = "constraint"
    VALUE = "value"
    COMMUNICATIVE = "communicative"
    SOCIAL = "social"
    MODAL = "modal"
    EVIDENTIAL = "evidential"
    COUNTERFACTUAL = "counterfactual"
    OPERATIONAL = "operational"
    MEASUREMENT = "measurement"
    AESTHETIC = "aesthetic"


RELATION_FAMILY_MAP: dict[str, AdjacencyFamily] = {
    "proximity": AdjacencyFamily.SPATIAL,
    "containment": AdjacencyFamily.SPATIAL,
    "overlap": AdjacencyFamily.SPATIAL,
    "path": AdjacencyFamily.SPATIAL,
    "barrier": AdjacencyFamily.SPATIAL,
    "adjacency:base": AdjacencyFamily.SPATIAL,
    "adjacency:cached": AdjacencyFamily.SPATIAL,
    "adjacency:cached-bridge": AdjacencyFamily.SPATIAL,
    "adjacency:layer:1": AdjacencyFamily.SPATIAL,
    "adjacency:layer:2": AdjacencyFamily.SPATIAL,
    "adjacency:layer:3": AdjacencyFamily.SPATIAL,
    "adjacency:layer:4": AdjacencyFamily.SPATIAL,
    "adjacency:layer:5": AdjacencyFamily.SPATIAL,
    "before": AdjacencyFamily.TEMPORAL,
    "after": AdjacencyFamily.TEMPORAL,
    "during": AdjacencyFamily.TEMPORAL,
    "recurrence": AdjacencyFamily.TEMPORAL,
    "cause": AdjacencyFamily.CAUSAL,
    "effect": AdjacencyFamily.CAUSAL,
    "enablement": AdjacencyFamily.CAUSAL,
    "inhibition": AdjacencyFamily.CAUSAL,
    "⇄": AdjacencyFamily.CAUSAL,
    "⇝": AdjacencyFamily.CAUSAL,
    "↼": AdjacencyFamily.CAUSAL,
    "seed-expansion": AdjacencyFamily.OPERATIONAL,
    "modifier:emphasis": AdjacencyFamily.COMMUNICATIVE,
    "modifier:query": AdjacencyFamily.COMMUNICATIVE,
    "modifier:left": AdjacencyFamily.COMMUNICATIVE,
    "modifier:right": AdjacencyFamily.COMMUNICATIVE,
    "modifier:close": AdjacencyFamily.COMMUNICATIVE,
    "modifier:other": AdjacencyFamily.COMMUNICATIVE,
    "self:symbol": AdjacencyFamily.AESTHETIC,
}


def classify_relation(key: str | None) -> AdjacencyFamily:
    normalized = (key or "").strip().lower()
    if not normalized:
        return AdjacencyFamily.AESTHETIC
    if normalized in RELATION_FAMILY_MAP:
        return RELATION_FAMILY_MAP[normalized]
    if normalized.startswith("adjacency:layer:"):
        return AdjacencyFamily.SPATIAL
    if normalized.startswith("adjacency:"):
        return AdjacencyFamily.SPATIAL
    if normalized.startswith("modifier:"):
        return AdjacencyFamily.COMMUNICATIVE
    if normalized == "∼":
        return AdjacencyFamily.SPATIAL
    return AdjacencyFamily.AESTHETIC
