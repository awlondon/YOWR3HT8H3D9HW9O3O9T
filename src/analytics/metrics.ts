import { SETTINGS } from '../settings';

export interface GraphEdge {
  type: string;
  w?: number;
}

export interface GraphNode {
  kind?: string;
  rawScore?: number;
}

export function adjustedWeight(edge: GraphEdge, scale = SETTINGS.symbolWeightScale): number {
  const weight = typeof edge.w === 'number' ? edge.w : 1;
  if (edge.type && edge.type.startsWith('modifier:')) {
    return weight * scale;
  }
  return weight;
}

export function nodeScore(node: GraphNode, scale = SETTINGS.symbolWeightScale): number {
  const base = typeof node.rawScore === 'number' ? node.rawScore : 1;
  if (node.kind === 'sym') {
    return base * scale;
  }
  return base;
}

export function rankNodes<T extends GraphNode & { token?: string }>(nodes: T[], topN = 20): T[] {
  const filtered = nodes.filter(node => node.kind !== 'sym' || SETTINGS.includeSymbolInSummaries);
  return filtered
    .map(node => ({ ...node, score: nodeScore(node) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topN);
}
