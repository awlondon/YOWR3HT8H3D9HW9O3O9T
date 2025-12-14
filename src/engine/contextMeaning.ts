import { ContextBasis } from './contextBasis.js';

function getBasisVector(ctx: ContextBasis, index: number): number[] {
  const dim = ctx.B.length / ctx.k;
  const start = index * dim;
  return Array.from(ctx.B.slice(start, start + dim));
}

export function projectToBasis(vec: number[], ctx: ContextBasis): {
  coords: number[];
  probs: number[];
  proj: number[];
} {
  if (!ctx.k || !ctx.B.length) {
    return { coords: [], probs: [], proj: [] };
  }
  const coords: number[] = [];
  const proj = new Array(vec.length).fill(0);
  for (let i = 0; i < ctx.k; i += 1) {
    const basisVec = getBasisVector(ctx, i);
    let dot = 0;
    for (let j = 0; j < Math.min(vec.length, basisVec.length); j += 1) {
      dot += vec[j] * basisVec[j];
    }
    coords.push(dot);
    for (let j = 0; j < proj.length && j < basisVec.length; j += 1) {
      proj[j] += dot * basisVec[j];
    }
  }
  const probs = coords.map((c) => c * c);
  return { coords, probs, proj };
}
