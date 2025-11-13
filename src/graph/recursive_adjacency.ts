import type { Token } from '../tokens/tokenize.js';
import { computeCosineSimilarityFromTokens } from '../vector/similarity.js';

export interface RecursiveAdjacencyEdge {
  sourceIndex: number;
  targetIndex: number;
  type: string;
  weight: number;
  level: number;
  similarity?: number;
  viaIndex?: number | null;
  pathLength?: number;
  meta: Record<string, unknown>;
}

export interface RecursiveAdjacencyOptions {
  maxDepth?: number;
  maxEdges?: number;
  maxDegree?: number;
  maxLayers?: number;
  maxDegreePerLayer?: number | number[];
  similarityThreshold?: number;
  strongSimilarityThreshold?: number;
  decayFactor?: number;
  computeSimilarity?: (source: Token, target: Token) => number;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function circularDistance(a: number, b: number, length: number): number {
  const direct = Math.abs(a - b);
  return Math.min(direct, length - direct);
}

function createMeta(
  sourceIndex: number,
  targetIndex: number,
  level: number,
  span: number,
  viaIndex: number,
  tokens: Token[],
  similarity: number | undefined,
  pathLength: number,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    level,
    sourceIndex,
    targetIndex,
    span,
    pathLength,
    sourceToken: tokens[sourceIndex]?.t,
    targetToken: tokens[targetIndex]?.t,
  };

  if (typeof similarity === 'number' && Number.isFinite(similarity)) {
    meta.similarity = similarity;
  }

  if (viaIndex >= 0) {
    meta.viaIndex = viaIndex;
    meta.viaToken = tokens[viaIndex]?.t;
  }

  return meta;
}

function resolveMaxEdges(total: number, requested?: number): number {
  const completeGraphEdges = (total * (total - 1)) / 2;
  if (!requested || requested <= 0) {
    return Math.min(completeGraphEdges, total * 8);
  }

  return Math.min(completeGraphEdges, Math.max(total, requested));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function buildRecursiveAdjacency(
  tokens: Token[],
  options: RecursiveAdjacencyOptions = {},
): RecursiveAdjacencyEdge[] {
  const total = tokens.length;
  if (total < 2) return [];

  const edges: RecursiveAdjacencyEdge[] = [];
  const connected = new Set<string>();
  const adjacency: Array<Set<number>> = Array.from({ length: total }, () => new Set<number>());

  const maxLayers = Math.max(1, options.maxLayers ?? options.maxDepth ?? 3);
  const maxEdges = resolveMaxEdges(total, options.maxEdges);
  const fallbackDegree = options.maxDegree ?? Math.max(4, Math.ceil(Math.log2(Math.max(2, total)) * 3));

  let rawDegree: number[];
  if (Array.isArray(options.maxDegreePerLayer)) {
    rawDegree = options.maxDegreePerLayer.map(value => Number(value) || 0);
  } else if (typeof options.maxDegreePerLayer === 'number') {
    const v = Number(options.maxDegreePerLayer) || fallbackDegree;
    rawDegree = Array.from({ length: maxLayers }, () => v);
  } else {
    rawDegree = Array.from({ length: maxLayers }, () => fallbackDegree);
  }

  const maxDegreePerLayer = Array.from({ length: maxLayers + 1 }, (_, index) => {
    if (index === 0) return Number.POSITIVE_INFINITY;
    const value = rawDegree[index - 1] ?? rawDegree[rawDegree.length - 1] ?? 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  });

  const perLayerDegree = Array.from({ length: total }, () => new Array(maxLayers + 1).fill(0));
  const decayFactor = options.decayFactor && Number.isFinite(options.decayFactor)
    ? Math.min(0.95, Math.max(0.1, options.decayFactor))
    : 0.72;
  const similarityFn = typeof options.computeSimilarity === 'function'
    ? options.computeSimilarity
    : computeCosineSimilarityFromTokens;
  const similarityThreshold = clamp01(options.similarityThreshold ?? 0.3);
  const strongSimilarityThreshold = clamp01(
    options.strongSimilarityThreshold ?? Math.max(similarityThreshold + 0.35, 0.8),
  );

  const pairSimilarityCache = new Map<string, number>();
  const resolveSimilarity = (a: number, b: number): number => {
    const key = pairKey(a, b);
    const cached = pairSimilarityCache.get(key);
    if (typeof cached === 'number') {
      return cached;
    }
    const similarity = similarityFn(tokens[a], tokens[b]);
    pairSimilarityCache.set(key, similarity);
    return similarity;
  };

  const connect = (
    a: number,
    b: number,
    level: number,
    viaIndex: number,
    similarity: number | undefined,
    pathLength: number,
  ): boolean => {
    if (a === b) return false;
    if (edges.length >= maxEdges) return false;
    if (level > maxLayers) return false;
    const key = pairKey(a, b);
    if (connected.has(key)) return false;
    const limit = maxDegreePerLayer[level] ?? 0;
    if (level > 0 && limit > 0) {
      if (perLayerDegree[a][level] >= limit) return false;
      if (perLayerDegree[b][level] >= limit) return false;
    }

    connected.add(key);
    adjacency[a].add(b);
    adjacency[b].add(a);
    perLayerDegree[a][level] += 1;
    perLayerDegree[b][level] += 1;

    const [sourceIndex, targetIndex] = a < b ? [a, b] : [b, a];
    const span = circularDistance(a, b, total);
    const type = level === 0 ? 'adjacency:base' : `adjacency:layer:${level}`;
    const effectiveSimilarity = typeof similarity === 'number' ? similarity : similarityThreshold;
    const weight = level === 0
      ? 1
      : Math.max(0.05, effectiveSimilarity * Math.pow(decayFactor, level));

    edges.push({
      sourceIndex,
      targetIndex,
      type,
      weight,
      level,
      similarity: typeof similarity === 'number' ? similarity : undefined,
      viaIndex: viaIndex >= 0 ? viaIndex : null,
      pathLength,
      meta: createMeta(
        sourceIndex,
        targetIndex,
        level,
        span,
        viaIndex,
        tokens,
        typeof similarity === 'number' ? similarity : undefined,
        pathLength,
      ),
    });

    return true;
  };

  for (let i = 0; i < total; i += 1) {
    const j = (i + 1) % total;
    connect(i, j, 0, -1, 1, 1);
  }

  const maxPathLength = maxLayers + 1;

  for (let source = 0; source < total && edges.length < maxEdges; source += 1) {
    const visited = new Map<number, { depth: number; via: number }>();
    const queue: Array<{ node: number; depth: number; via: number }> = [];

    for (const neighbor of adjacency[source]) {
      if (neighbor === source) continue;
      if (visited.has(neighbor)) continue;
      visited.set(neighbor, { depth: 1, via: neighbor });
      queue.push({ node: neighbor, depth: 1, via: neighbor });
    }

    while (queue.length && edges.length < maxEdges) {
      const { node, depth, via } = queue.shift()!;
      const level = depth - 1;

      if (depth >= 2 && level <= maxLayers) {
        const limit = maxDegreePerLayer[level] ?? 0;
        if (
          level === 0
          || limit === 0
          || (perLayerDegree[source][level] < limit && perLayerDegree[node][level] < limit)
        ) {
          const similarity = resolveSimilarity(source, node);
          if (similarity >= similarityThreshold) {
            connect(source, node, level, via, similarity, depth);
          }
        }
      }

      if (depth >= maxPathLength) {
        continue;
      }

      for (const next of adjacency[node]) {
        if (next === source) continue;
        const nextDepth = depth + 1;
        if (nextDepth > maxPathLength) continue;
        const existing = visited.get(next);
        if (existing && existing.depth <= nextDepth) {
          continue;
        }
        visited.set(next, { depth: nextDepth, via });
        queue.push({ node: next, depth: nextDepth, via });
      }
    }
  }

  const ensureBoundedHopConnectivity = () => {
    if (!(strongSimilarityThreshold > similarityThreshold)) return;
    const level = Math.min(maxLayers, maxDegreePerLayer.length - 1);
    if (level <= 0) return;
    const limit = maxDegreePerLayer[level] ?? 0;

    const distances = new Array<number>(total);
    const bfsQueue: number[] = [];

    for (let source = 0; source < total && edges.length < maxEdges; source += 1) {
      distances.fill(Number.POSITIVE_INFINITY);
      bfsQueue.length = 0;
      distances[source] = 0;
      bfsQueue.push(source);

      while (bfsQueue.length) {
        const current = bfsQueue.shift()!;
        if (distances[current] >= level) continue;
        for (const next of adjacency[current]) {
          const nextDistance = distances[current] + 1;
          if (nextDistance > level) continue;
          if (distances[next] <= nextDistance) continue;
          distances[next] = nextDistance;
          bfsQueue.push(next);
        }
      }

      for (let target = source + 1; target < total && edges.length < maxEdges; target += 1) {
        const similarity = resolveSimilarity(source, target);
        if (similarity < strongSimilarityThreshold) continue;
        const pathLength = distances[target];
        if (Number.isFinite(pathLength) && pathLength <= level) continue;
        if (limit > 0) {
          if (perLayerDegree[source][level] >= limit) continue;
          if (perLayerDegree[target][level] >= limit) continue;
        }
        connect(source, target, level, -1, similarity, level + 1);
      }
    }
  };

  ensureBoundedHopConnectivity();

  return edges;
}

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
    const keep = nodes.filter(n => n?.token && connected.has(n.token as string));
    if (keep.length <= maxN) {
      nodes.length = 0;
      nodes.push(...keep);
    } else {
      nodes.length = 0;
      nodes.push(...keep.slice(0, maxN));
    }
  }
}
