import { SETTINGS } from '../settings.js';
import { AdjacencyFamily, classifyRelation } from '../types/adjacencyFamilies.js';

export interface GraphEdge {
  type: string;
  w?: number;
  family?: AdjacencyFamily;
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

/** Return a simple histogram of edge weights (rounded to 2 decimals). */
export function edgeWeightHistogram(edges: GraphEdge[]): Record<string, number> {
  const hist: Record<string, number> = Object.create(null);
  for (const e of edges || []) {
    const w = typeof e.w === 'number' && Number.isFinite(e.w) ? e.w : 0;
    const key = (Math.round(w * 100) / 100).toFixed(2);
    hist[key] = (hist[key] || 0) + 1;
  }
  return hist;
}

export function edgeFamilyHistogram(edges: GraphEdge[]): Record<AdjacencyFamily, number> {
  const hist: Record<AdjacencyFamily, number> = {
    [AdjacencyFamily.Spatial]: 0,
    [AdjacencyFamily.Temporal]: 0,
    [AdjacencyFamily.Causal]: 0,
    [AdjacencyFamily.Hierarchical]: 0,
    [AdjacencyFamily.Analogical]: 0,
    [AdjacencyFamily.Constraint]: 0,
    [AdjacencyFamily.Value]: 0,
    [AdjacencyFamily.Communicative]: 0,
    [AdjacencyFamily.Social]: 0,
    [AdjacencyFamily.Modal]: 0,
    [AdjacencyFamily.Evidential]: 0,
    [AdjacencyFamily.Counterfactual]: 0,
    [AdjacencyFamily.Operational]: 0,
    [AdjacencyFamily.Measurement]: 0,
    [AdjacencyFamily.Aesthetic]: 0,
  };

  for (const edge of edges || []) {
    const family = edge.family ?? classifyRelation(edge.type);
    hist[family] += 1;
  }

  return hist;
}

/** Quick connectivity check using an undirected view for robustness. */
export function graphHealth(nodes: Array<{token?: string}> = [], edges: Array<{source?: string, target?: string}> = []) {
  const nodeSet = new Set<string>();
  for (const n of nodes) {
    if (n && typeof n.token === 'string' && n.token) nodeSet.add(n.token);
  }
  const adj: Record<string, Set<string>> = Object.create(null);
  for (const t of nodeSet) adj[t] = new Set();
  for (const e of edges || []) {
    const a = e?.source ?? '';
    const b = e?.target ?? '';
    if (!a || !b || !nodeSet.has(a) || !nodeSet.has(b)) continue;
    adj[a].add(b);
    adj[b].add(a); // undirected check
  }
  // trivial empty or single node
  if (nodeSet.size <= 1) {
    return { nodeCount: nodeSet.size, edgeCount: edges?.length ?? 0, isolatedNodes: [], stronglyConnected: nodeSet.size <= 1 };
  }
  // BFS from an arbitrary node
  const start = nodeSet.values().next().value as string;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj[cur]) {
      if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
    }
  }
  const isolatedNodes = [...nodeSet].filter(t => adj[t].size === 0);
  const stronglyConnected = seen.size === nodeSet.size;
  return { nodeCount: nodeSet.size, edgeCount: edges?.length ?? 0, isolatedNodes, stronglyConnected };
}
