import type { Token } from '../tokens/tokenize.js';

export interface RecursiveAdjacencyEdge {
  sourceIndex: number;
  targetIndex: number;
  type: string;
  weight: number;
  meta: Record<string, unknown>;
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

export function buildRecursiveAdjacency(tokens: Token[]): RecursiveAdjacencyEdge[] {
  const total = tokens.length;
  if (total < 2) return [];

  const edges: RecursiveAdjacencyEdge[] = [];
  const connected = new Set<string>();
  const adjacency: Array<Set<number>> = Array.from({ length: total }, () => new Set<number>());
  const targetPairCount = (total * (total - 1)) / 2;

  const connect = (a: number, b: number, level: number, viaIndex: number) => {
    if (a === b) return false;
    const key = pairKey(a, b);
    if (connected.has(key)) return false;

    connected.add(key);
    adjacency[a].add(b);
    adjacency[b].add(a);

    const [sourceIndex, targetIndex] = a < b ? [a, b] : [b, a];
    const span = circularDistance(a, b, total);
    const type = level === 0 ? 'adjacency:base' : 'adjacency:expanded';
    const weight = level === 0 ? 1 : Math.max(0.1, 1 / (level + 1));

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

  if (connected.size >= targetPairCount) {
    return edges;
  }

  let level = 1;
  while (connected.size < targetPairCount) {
    let addedThisLevel = 0;

    for (let i = 0; i < total; i += 1) {
      for (let j = i + 1; j < total; j += 1) {
        const key = pairKey(i, j);
        if (connected.has(key)) continue;

        let viaIndex = -1;
        for (const neighbor of adjacency[i]) {
          if (adjacency[neighbor].has(j)) {
            viaIndex = neighbor;
            break;
          }
        }

        if (viaIndex === -1) continue;

        if (connect(i, j, level, viaIndex)) {
          addedThisLevel += 1;
        }
      }
    }

    if (addedThisLevel === 0) {
      break;
    }

    level += 1;
  }

  return edges;
}
