export type {
  LayeredAdjacencyEdge as RecursiveAdjacencyEdge,
  LayeredExpansionOptions as RecursiveAdjacencyOptions,
} from './layeredAdjacency.js';
export { buildLayeredAdjacency as buildRecursiveAdjacency } from './layeredAdjacency.js';

/** Lightweight pruning to respect edge and node caps */
export function pruneToLimits<TNode extends { token?: string }>(
  nodes: TNode[],
  edges: Array<{ source: string; target: string; w?: number }>,
  opts: { maxNodes?: number; maxEdges?: number; pruneWeightThreshold?: number } = {},
) {
  const maxN = Math.max(0, Number(opts.maxNodes ?? Infinity));
  const maxE = Math.max(0, Number(opts.maxEdges ?? Infinity));
  const pruneW = Number.isFinite(opts.pruneWeightThreshold as number)
    ? Number(opts.pruneWeightThreshold)
    : -Infinity;

  // 1) Drop low-weight edges
  edges.sort((a, b) => (a.w ?? 0) - (b.w ?? 0));
  while (edges.length > maxE) {
    const next = edges[0];
    if ((next.w ?? 0) > pruneW) break;
    edges.shift();
  }
  // 2) Drop isolated nodes if still over cap
  if (Number.isFinite(maxN) && nodes.length > maxN) {
    const connected = new Set<string>();
    for (const e of edges) {
      if (e.source) connected.add(e.source);
      if (e.target) connected.add(e.target);
    }
    const keep = nodes.filter((n) => n?.token && connected.has(n.token as string));
    if (keep.length <= maxN) {
      nodes.length = 0;
      nodes.push(...keep);
    } else {
      nodes.length = 0;
      nodes.push(...keep.slice(0, maxN));
    }
  }
}
