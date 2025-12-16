import type { Node as EngineNode, Edge as EngineEdge } from './cognitionTypes.js';
import type { ContextBasis } from './contextBasis.js';
import { projectToBasis } from './contextMeaning.js';

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

function normalizeScores(map: Map<string, number>): Map<string, number> {
  const normalized = new Map<string, number>();
  const max = Math.max(...Array.from(map.values()), 0);
  if (!max || !Number.isFinite(max)) return normalized;
  map.forEach((value, key) => {
    normalized.set(key, value / max);
  });
  return normalized;
}

function computeWeightedDegree(graph: SalienceGraph): Map<string, number> {
  const degree = new Map<string, number>();
  graph.edges.forEach((edge) => {
    const weight = edge.weight ?? (edge as any).w ?? 0;
    degree.set(edge.src, (degree.get(edge.src) || 0) + weight);
    degree.set(edge.dst, (degree.get(edge.dst) || 0) + weight);
  });
  return degree;
}

export function computeIntertwiningIndex(contexts: ContextBasis[]): Map<string, number> {
  const intertwined = new Map<string, number>();
  contexts.forEach((ctx) => {
    ctx.tokenIds.forEach((tokenId) => {
      intertwined.set(tokenId, (intertwined.get(tokenId) || 0) + 1);
    });
  });
  return intertwined;
}

export function computeProjectionPeakiness(
  activeContext: ContextBasis | undefined,
  embeddings: Map<string, number[]>,
): Map<string, number> {
  const peakiness = new Map<string, number>();
  if (!activeContext || !activeContext.k) return peakiness;
  activeContext.tokenIds.forEach((tokenId, index) => {
    const vec = embeddings.get(tokenId);
    if (!vec) return;
    const { probs } = projectToBasis(vec, activeContext);
    const score = probs.length ? Math.max(...probs) : 0;
    if (Number.isFinite(score)) {
      peakiness.set(tokenId, score);
    }
  });
  return peakiness;
}

export function computeContextualSalience(
  graph: SalienceGraph,
  contexts: ContextBasis[],
  activeContext: ContextBasis | undefined,
  embeddings: Map<string, number[]>,
): Map<string, number> {
  const weightedDegree = normalizeScores(computeWeightedDegree(graph));
  const intertwining = normalizeScores(computeIntertwiningIndex(contexts));
  const projection = normalizeScores(computeProjectionPeakiness(activeContext, embeddings));
  const salience = new Map<string, number>();
  graph.nodes.forEach((_node, id) => {
    const degreeScore = weightedDegree.get(id) || 0;
    const intertwinedScore = intertwining.get(id) || 0;
    const projectionScore = projection.get(id) || 0;
    const score = degreeScore * 0.55 + intertwinedScore * 0.3 + projectionScore * 0.15;
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
  const neighborCap = Math.max(
    3,
    Math.min(
      graph.nodes.size,
      Number((graph as any).meta?.o10Size ?? (graph as any).metadata?.o10Size ?? 9),
    ),
  );
  graph.edges.forEach((edge) => {
    if (!adjacency.has(edge.src)) adjacency.set(edge.src, new Set());
    if (!adjacency.has(edge.dst)) adjacency.set(edge.dst, new Set());
    adjacency.get(edge.src)?.add(edge.dst);
    adjacency.get(edge.dst)?.add(edge.src);
  });

  keepCenters.forEach((center) => {
    const weightedNeighbors = graph.edges
      .filter((edge) => edge.src === center || edge.dst === center)
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, neighborCap);
    weightedNeighbors.forEach((edge) => {
      const neighbor = edge.src === center ? edge.dst : edge.src;
      if (neighbor) keep.add(neighbor);
    });
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

  if (nodes.size < 2) {
    return graph;
  }

  return { nodes, edges };
}

export function simplifyLabelsForUI(nodes: Map<string, { label: string }>): string[] {
  return Array.from(nodes.values()).map((node) => node.label);
}
