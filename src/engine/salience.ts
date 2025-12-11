import type { Node as EngineNode, Edge as EngineEdge } from './cognitionTypes.js';

export interface SalienceGraph {
  nodes: Map<string, EngineNode & { meta?: Record<string, unknown> }>;
  edges: Array<EngineEdge & { layer?: 'visible' | 'hidden' }>;
}

export function computeTokenSalience(graph: SalienceGraph): Map<string, number> {
  const salience = new Map<string, number>();
  const edgeCounts = new Map<string, number>();
  const weightSums = new Map<string, number>();

  graph.edges.forEach((edge) => {
    edgeCounts.set(edge.src, (edgeCounts.get(edge.src) || 0) + 1);
    edgeCounts.set(edge.dst, (edgeCounts.get(edge.dst) || 0) + 1);
    weightSums.set(edge.src, (weightSums.get(edge.src) || 0) + edge.weight);
    weightSums.set(edge.dst, (weightSums.get(edge.dst) || 0) + edge.weight);
  });

  graph.nodes.forEach((_node, id) => {
    const weightedDegree = edgeCounts.get(id) || 0;
    const sumEdgeWeights = weightSums.get(id) || 0;
    const freq = typeof (_node as any).appearanceFrequency === 'number'
      ? (_node as any).appearanceFrequency
      : 0;
    const score = weightedDegree * 0.6 + sumEdgeWeights * 0.3 + freq * 0.1;
    salience.set(id, score);
  });

  return salience;
}

export function topSalienceTokens(salienceMap: Map<string, number>, k: number): string[] {
  return Array.from(salienceMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, k))
    .map(([id]) => id);
}

export function collapseGraph(
  graph: SalienceGraph,
  keepCenters: string[],
  radius: number,
): SalienceGraph {
  const keep = new Set<string>(keepCenters);
  const adjacency = new Map<string, Set<string>>();
  graph.edges.forEach((edge) => {
    if (!adjacency.has(edge.src)) adjacency.set(edge.src, new Set());
    if (!adjacency.has(edge.dst)) adjacency.set(edge.dst, new Set());
    adjacency.get(edge.src)?.add(edge.dst);
    adjacency.get(edge.dst)?.add(edge.src);
  });

  // BFS to collect nodes within radius from centers
  const queue: Array<{ id: string; depth: number }> = keepCenters.map((id) => ({ id, depth: 0 }));
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (depth >= radius) continue;
    const neighbors = adjacency.get(id);
    if (!neighbors) continue;
    neighbors.forEach((n) => {
      if (!keep.has(n)) {
        keep.add(n);
        queue.push({ id: n, depth: depth + 1 });
      }
    });
  }

  const nodes = new Map<string, EngineNode & { meta?: Record<string, unknown> }>();
  graph.nodes.forEach((node, id) => {
    if (keep.has(id)) nodes.set(id, node);
  });
  const edges = graph.edges.filter((edge) => keep.has(edge.src) && keep.has(edge.dst));

  return { nodes, edges };
}

export function simplifyLabelsForUI(nodes: Map<string, { label: string }>): string[] {
  return Array.from(nodes.values()).map((node) => node.label);
}
