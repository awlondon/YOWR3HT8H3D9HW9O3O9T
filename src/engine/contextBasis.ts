import { dot, norm } from './vectorUtils.js';

export type ContextId = string;

export interface ContextBasis {
  id: ContextId;
  anchorTokenId: string;
  tokenIds: string[];
  B: Float32Array;
  k: number;
  meta: {
    createdAt: number;
    level: number;
    source: 'ring' | 'cc' | 'cluster';
  };
}

function normalizeVector(vec: number[]): number[] {
  const magnitude = norm(vec);
  if (!magnitude || !Number.isFinite(magnitude)) return new Array(vec.length).fill(0);
  return vec.map((v) => v / magnitude);
}

export function buildContextBasis(
  anchorVec: number[],
  memberVecs: number[][],
  k: number,
  tokenOrder?: string[],
  anchorTokenId = 'anchor',
  meta?: ContextBasis['meta'],
): ContextBasis {
  const dimension = anchorVec.length;
  const targetK = Math.max(1, Math.min(k, dimension));
  const basisVectors: number[][] = [];
  const basisTokens: string[] = [];

  const anchorNorm = normalizeVector(anchorVec);
  const anchorMagnitude = norm(anchorVec);
  if (anchorMagnitude > 0 && anchorNorm.some((v) => Number.isFinite(v))) {
    basisVectors.push(anchorNorm);
    basisTokens.push(anchorTokenId);
  }

  const members = [...memberVecs];
  const tokens = tokenOrder ?? [];
  for (let i = 0; i < members.length && basisVectors.length < targetK; i += 1) {
    const candidate = members[i] ?? [];
    if (!candidate.length) continue;
    let orthogonal = [...candidate];
    basisVectors.forEach((basis) => {
      const projection = dot(candidate, basis);
      for (let j = 0; j < orthogonal.length; j += 1) {
        orthogonal[j] -= projection * basis[j];
      }
    });
    const magnitude = norm(orthogonal);
    if (magnitude > 1e-6) {
      const normalized = orthogonal.map((v) => v / magnitude);
      basisVectors.push(normalized);
      const token = tokens[i] ?? `ctx-${i}`;
      basisTokens.push(token);
    }
  }

  const usedK = basisVectors.length;
  const B = new Float32Array(dimension * usedK);
  basisVectors.forEach((vec, col) => {
    vec.forEach((value, row) => {
      B[col * dimension + row] = value;
    });
  });

  const context: ContextBasis = {
    id: `${anchorTokenId}-${Date.now()}`,
    anchorTokenId,
    tokenIds: basisTokens,
    B,
    k: usedK,
    meta: meta ?? { createdAt: Date.now(), level: 0, source: 'ring' },
  };

  return context;
}
