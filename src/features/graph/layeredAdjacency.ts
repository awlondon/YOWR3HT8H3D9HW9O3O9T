import type { Token } from '../../tokens/tokenize.js';
import { computeCosineSimilarityFromTokens } from '../../vector/similarity.js';

export interface LayeredAdjacencyEdge {
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

export interface LayeredExpansionConfig {
  maxLayers: number;
  maxEdges: number;
  maxDegreePerLayer: number[];
  similarityThreshold: number;
  strongSimilarityThreshold: number;
  decayFactor: number;
  computeSimilarity: (source: Token, target: Token) => number;
}

export type LayeredExpansionOptions = Partial<
  Omit<LayeredExpansionConfig, 'maxDegreePerLayer' | 'computeSimilarity'>
> & {
  maxDegreePerLayer?: number | number[];
  computeSimilarity?: (source: Token, target: Token) => number;
  maxDepth?: number;
  maxDegree?: number;
};

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function circularDistance(a: number, b: number, length: number): number {
  const direct = Math.abs(a - b);
  return Math.min(direct, length - direct);
}

function clamp01(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  const numeric = Number(value);
  if (numeric <= 0) return 0;
  if (numeric >= 1) return 1;
  return numeric;
}

function resolveMaxEdges(total: number, requested?: number): number {
  const completeGraphEdges = (total * (total - 1)) / 2;
  if (!requested || requested <= 0) {
    return Math.min(completeGraphEdges, total * 8);
  }
  return Math.min(completeGraphEdges, Math.max(total, requested));
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

function normaliseDegreeCaps(
  maxLayers: number,
  raw: number | number[] | undefined,
  fallback: number,
): number[] {
  const caps: number[] = [];
  if (Array.isArray(raw)) {
    caps.push(...raw.map((value) => Number(value) || 0));
  } else if (typeof raw === 'number') {
    const value = Number(raw) || fallback;
    for (let i = 0; i < maxLayers; i += 1) {
      caps.push(value);
    }
  } else {
    for (let i = 0; i < maxLayers; i += 1) {
      caps.push(fallback);
    }
  }
  return caps;
}

function resolveConfig(
  total: number,
  options: LayeredExpansionOptions = {},
): LayeredExpansionConfig {
  const maxLayers = Math.max(1, Math.floor(options.maxLayers ?? options.maxDepth ?? 3));
  const resolvedFallback = Number.isFinite(options.maxDegree)
    ? Math.max(1, Number(options.maxDegree))
    : Math.max(4, Math.ceil(Math.log2(Math.max(2, total)) * 3));
  const fallbackDegree = Number.isFinite(resolvedFallback) ? resolvedFallback : 4;
  const degreeCaps = normaliseDegreeCaps(maxLayers, options.maxDegreePerLayer, fallbackDegree);
  const maxDegreePerLayer = [
    Number.POSITIVE_INFINITY,
    ...degreeCaps.map((cap) => (cap > 0 && Number.isFinite(cap) ? cap : 0)),
  ];

  const similarityThreshold = clamp01(options.similarityThreshold ?? 0.3);
  const strongSimilarityThreshold = clamp01(
    options.strongSimilarityThreshold ?? Math.max(similarityThreshold + 0.35, 0.8),
  );

  return {
    maxLayers,
    maxEdges: resolveMaxEdges(total, options.maxEdges),
    maxDegreePerLayer,
    similarityThreshold,
    strongSimilarityThreshold,
    decayFactor:
      options.decayFactor && Number.isFinite(options.decayFactor)
        ? Math.min(0.95, Math.max(0.1, Number(options.decayFactor)))
        : 0.72,
    computeSimilarity: options.computeSimilarity ?? computeCosineSimilarityFromTokens,
  };
}

/**
 * Builds a layered adjacency graph following a lightweight graph-spanner style
 * expansion strategy. The routine starts with deterministic level-0 edges then
 * iteratively grows higher-order connections where cosine similarity clears the
 * configurable thresholds. See <https://drops.dagstuhl.de/opus/volltexte/2019/11082/>
 * for background on layered spanners and bounded-diameter guarantees.
 */
export function buildLayeredAdjacency(
  tokens: Token[],
  options: LayeredExpansionOptions = {},
): LayeredAdjacencyEdge[] {
  const total = tokens.length;
  if (total < 2) return [];

  const config = resolveConfig(total, options);
  const edges: LayeredAdjacencyEdge[] = [];
  const connected = new Set<string>();
  const adjacency: Array<Set<number>> = Array.from({ length: total }, () => new Set<number>());
  const perLayerDegree = Array.from({ length: total }, () =>
    new Array(config.maxLayers + 1).fill(0),
  );

  const similarityCache = new Map<string, number>();
  const resolveSimilarity = (a: number, b: number): number => {
    const key = pairKey(a, b);
    const cached = similarityCache.get(key);
    if (typeof cached === 'number') return cached;
    const similarity = config.computeSimilarity(tokens[a], tokens[b]);
    similarityCache.set(key, similarity);
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
    if (edges.length >= config.maxEdges) return false;
    if (level > config.maxLayers) return false;
    const key = pairKey(a, b);
    if (connected.has(key)) return false;
    const limit = config.maxDegreePerLayer[level] ?? 0;
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
    const effectiveSimilarity =
      typeof similarity === 'number' ? similarity : config.similarityThreshold;
    const weight =
      level === 0 ? 1 : Math.max(0.05, effectiveSimilarity * Math.pow(config.decayFactor, level));

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

  const queue: Array<{ node: number; depth: number; via: number } | null> = [];

  for (let level = 1; level <= config.maxLayers && edges.length < config.maxEdges; level += 1) {
    const targetDepth = level + 1;
    for (let source = 0; source < total && edges.length < config.maxEdges; source += 1) {
      const limit = config.maxDegreePerLayer[level] ?? 0;
      if (limit > 0 && perLayerDegree[source][level] >= limit) {
        continue;
      }

      const visited = new Map<number, { depth: number; via: number }>();
      queue.length = 0;

      for (const neighbor of adjacency[source]) {
        if (neighbor === source) continue;
        if (visited.has(neighbor)) continue;
        visited.set(neighbor, { depth: 1, via: neighbor });
        queue.push({ node: neighbor, depth: 1, via: neighbor });
      }

      let head = 0;
      while (head < queue.length && edges.length < config.maxEdges) {
        const current = queue[head];
        head += 1;
        if (!current) continue;
        const { node, depth, via } = current;
        if (depth >= targetDepth) {
          continue;
        }
        for (const next of adjacency[node]) {
          if (next === source) continue;
          const nextDepth = depth + 1;
          if (nextDepth > targetDepth) continue;
          const existing = visited.get(next);
          if (existing && existing.depth <= nextDepth) continue;
          visited.set(next, { depth: nextDepth, via });
          if (nextDepth < targetDepth) {
            queue.push({ node: next, depth: nextDepth, via });
          }
        }
      }

      for (const [target, visit] of visited.entries()) {
        if (visit.depth !== targetDepth) continue;
        if (limit > 0 && perLayerDegree[source][level] >= limit) break;
        if (limit > 0 && perLayerDegree[target][level] >= limit) continue;

        const similarity = resolveSimilarity(source, target);
        if (similarity < config.similarityThreshold) continue;
        if (connect(source, target, level, visit.via, similarity, visit.depth)) {
          if (limit > 0 && perLayerDegree[source][level] >= limit) {
            break;
          }
        }
        if (edges.length >= config.maxEdges) break;
      }
    }
  }

  const ensureBoundedHopConnectivity = () => {
    if (!(config.strongSimilarityThreshold > config.similarityThreshold)) {
      return;
    }
    const level = Math.min(config.maxLayers, config.maxDegreePerLayer.length - 1);
    if (level <= 0) return;
    const limit = config.maxDegreePerLayer[level] ?? 0;
    const distances = new Array<number>(total);
    const bfsQueue: number[] = [];

    for (let source = 0; source < total && edges.length < config.maxEdges; source += 1) {
      distances.fill(Number.POSITIVE_INFINITY);
      bfsQueue.length = 0;
      distances[source] = 0;
      bfsQueue.push(source);

      let cursor = 0;
      while (cursor < bfsQueue.length) {
        const current = bfsQueue[cursor];
        cursor += 1;
        if (distances[current] >= level) continue;
        for (const next of adjacency[current]) {
          const nextDistance = distances[current] + 1;
          if (nextDistance > level) continue;
          if (distances[next] <= nextDistance) continue;
          distances[next] = nextDistance;
          bfsQueue.push(next);
        }
      }

      for (let target = source + 1; target < total && edges.length < config.maxEdges; target += 1) {
        const similarity = resolveSimilarity(source, target);
        if (similarity < config.strongSimilarityThreshold) continue;
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
