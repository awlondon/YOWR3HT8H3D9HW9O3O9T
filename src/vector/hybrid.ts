import type { HybridExpandOptions, SimilarResult } from './types';

export async function hybridExpand(
  opt: HybridExpandOptions,
  deps: {
    store: { get(id: number): Promise<Float32Array | null>; similar(id: number, k: number): Promise<SimilarResult[]> };
    kb?: {
      getAdj(q: { tokenId: number; minWeight?: number; type?: number[]; limit?: number }): Promise<Array<{ neighborId: number; w: number }>>;
    };
  },
): Promise<SimilarResult[]> {
  const alpha = opt.alpha ?? 0.6;
  const beta = opt.beta ?? 0.4;
  const limit = Math.max(1, opt.topK);
  const [graph, vect] = await Promise.all([
    deps.kb?.getAdj({ tokenId: opt.tokenId, minWeight: opt.minWeight, type: opt.types, limit: limit * 3 }) ??
      Promise.resolve([]),
    deps.store.similar(opt.tokenId, limit * 3),
  ]);

  const scores = new Map<number, number>();

  if (graph.length) {
    const maxWeight = graph.reduce((max, edge) => (edge.w > max ? edge.w : max), graph[0]?.w ?? 1);
    const safeMax = maxWeight === 0 ? 1 : maxWeight;
    for (const edge of graph) {
      const normalized = edge.w / safeMax;
      const weight = alpha * normalized;
      const prev = scores.get(edge.neighborId) ?? 0;
      scores.set(edge.neighborId, prev + weight);
    }
  }

  if (vect.length) {
    const maxScore = vect.reduce((max, entry) => (entry.score > max ? entry.score : max), vect[0]?.score ?? 1);
    const safeMax = maxScore === 0 ? 1 : maxScore;
    for (const entry of vect) {
      const normalized = entry.score / safeMax;
      const weight = beta * normalized;
      const prev = scores.get(entry.id) ?? 0;
      scores.set(entry.id, prev + weight);
    }
  }

  const combined = Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return combined;
}
