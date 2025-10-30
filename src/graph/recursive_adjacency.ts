import type { Token } from '../tokens/tokenize.js';

export interface RecursiveAdjacencyEdge {
  sourceIndex: number;
  targetIndex: number;
  type: string;
  weight: number;
  meta: Record<string, unknown>;
}

export interface RecursiveAdjacencyOptions {
  maxDepth?: number;
  maxEdges?: number;
  maxDegree?: number;
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
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    level,
    sourceIndex,
    targetIndex,
    span,
    sourceToken: tokens[sourceIndex]?.t,
    targetToken: tokens[targetIndex]?.t,
  };

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

export function buildRecursiveAdjacency(
  tokens: Token[],
  options: RecursiveAdjacencyOptions = {},
): RecursiveAdjacencyEdge[] {
  const total = tokens.length;
  if (total < 2) return [];

  const edges: RecursiveAdjacencyEdge[] = [];
  const connected = new Set<string>();
  const adjacency: Array<Set<number>> = Array.from({ length: total }, () => new Set<number>());

  const maxDepth = options.maxDepth ?? 4;
  const maxDegree = options.maxDegree ?? Math.max(4, Math.ceil(Math.log2(total) * 4));
  const maxEdges = resolveMaxEdges(total, options.maxEdges);

  const connect = (a: number, b: number, level: number, viaIndex: number): boolean => {
    if (a === b) return false;
    const key = pairKey(a, b);
    if (connected.has(key)) return false;
    if (edges.length >= maxEdges) return false;

    const baseEdge = level === 0;
    if (!baseEdge) {
      if (adjacency[a].size >= maxDegree) return false;
      if (adjacency[b].size >= maxDegree) return false;
    }

    connected.add(key);
    adjacency[a].add(b);
    adjacency[b].add(a);

    const [sourceIndex, targetIndex] = a < b ? [a, b] : [b, a];
    const span = circularDistance(a, b, total);
    const type = baseEdge ? 'adjacency:base' : 'adjacency:expanded';
    const weight = baseEdge ? 1 : Math.max(0.1, 1 / (level + 1));

    edges.push({
      sourceIndex,
      targetIndex,
      type,
      weight,
      meta: createMeta(sourceIndex, targetIndex, level, span, viaIndex, tokens),
    });

    return true;
  };

  // Initial circular adjacency pass.
  for (let i = 0; i < total; i += 1) {
    const j = (i + 1) % total;
    connect(i, j, 0, -1);
  }

  const queue: Array<{ source: number; target: number; via: number; level: number }> = [];
  const seen = new Set<string>();
  const pairLevels = new Map<string, number>();

  const enqueue = (source: number, target: number, via: number, level: number) => {
    if (level > maxDepth) return;
    const pair = pairKey(source, target);
    const previousLevel = pairLevels.get(pair);
    if (previousLevel !== undefined && level >= previousLevel) return;
    pairLevels.set(pair, level);
    const key = `${source}-${target}-${via}-${level}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ source, target, via, level });
  };

  for (let i = 0; i < total; i += 1) {
    for (const neighbor of adjacency[i]) {
      for (const candidate of adjacency[neighbor]) {
        if (candidate === i) continue;
        enqueue(i, candidate, neighbor, 1);
      }
    }
  }

  let cursor = 0;
  while (cursor < queue.length && edges.length < maxEdges) {
    const { source, target, via, level } = queue[cursor++]!;
    if (level > maxDepth) continue;
    const pair = pairKey(source, target);
    const bestLevel = pairLevels.get(pair);
    if (bestLevel !== undefined && level > bestLevel) {
      continue;
    }

    if (!connected.has(pairKey(source, target))) {
      if (!connect(source, target, level, via)) {
        continue;
      }
    }

    if (level >= maxDepth) {
      continue;
    }

    for (const next of adjacency[target]) {
      if (next === source) continue;
      enqueue(source, next, target, level + 1);
    }
  }

  return edges;
}


/** Lightweight pruning to respect edge and node caps */
export function pruneToLimits<TNode extends { token?: string }>(nodes: TNode[], edges: Array<{source:string,target:string,w?:number}>, opts: { maxNodes?: number; maxEdges?: number; pruneWeightThreshold?: number } = {}) {
  const maxN = Math.max(0, Number(opts.maxNodes ?? Infinity));
  const maxE = Math.max(0, Number(opts.maxEdges ?? Infinity));
  const pruneW = Number.isFinite(opts.pruneWeightThreshold as number) ? Number(opts.pruneWeightThreshold) : -Infinity;

  // 1) Drop low-weight edges
  edges.sort((a,b) => (a.w ?? 0) - (b.w ?? 0));
  while (edges.length > maxE) {
    const next = edges[0];
    if ((next.w ?? 0) > pruneW) break;
    edges.shift();
  }
  // 2) Drop isolated nodes if still over cap
  if (Number.isFinite(maxN) && nodes.length > maxN) {
    const connected = new Set<string>();
    for (const e of edges) { if (e.source) connected.add(e.source); if (e.target) connected.add(e.target); }
    const keep = nodes.filter(n => n?.token && connected.has(n.token as string));
    if (keep.length <= maxN) {
      nodes.length = 0; nodes.push(...keep);
    } else {
      nodes.length = 0; nodes.push(...keep.slice(0, maxN));
    }
  }
}
