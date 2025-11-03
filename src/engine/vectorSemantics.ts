import type { PipelineResult } from './pipeline';

export interface TokenEmbedding {
  token: string;
  vector: number[];
  updatedAt: number;
}

export interface EmbeddingSummary {
  embeddings: TokenEmbedding[];
  globalMetrics: {
    symbolDensity: number;
    averageWeight: number;
  };
}

export function computeEmbeddingsFromPipeline(result: PipelineResult | null): EmbeddingSummary {
  if (!result) {
    return { embeddings: [], globalMetrics: { symbolDensity: 0, averageWeight: 0 } };
  }

  const metrics = result.metrics || {
    symbolDensity: 0,
    weightSum: 0,
    edgeCount: 0,
  } as PipelineResult['metrics'];

  const tokenStats = new Map<string, { degree: number; weightSum: number; symbolEdges: number }>();
  const now = Date.now();

  const recordEdge = (token: string, weight: number, isSymbolEdge: boolean) => {
    if (!token) return;
    const key = token.toLowerCase();
    if (!tokenStats.has(key)) {
      tokenStats.set(key, { degree: 0, weightSum: 0, symbolEdges: 0 });
    }
    const stats = tokenStats.get(key)!;
    stats.degree += 1;
    stats.weightSum += Number.isFinite(weight) ? weight : 0;
    if (isSymbolEdge) stats.symbolEdges += 1;
  };

  for (const edge of result.edges ?? []) {
    if (!edge) continue;
    const weight = Number(edge.w) || 0;
    const isSymbolEdge = typeof edge.type === 'string' && edge.type.startsWith('modifier');
    recordEdge(edge.source || '', weight, isSymbolEdge);
    recordEdge(edge.target || '', weight, isSymbolEdge);
  }

  const embeddings: TokenEmbedding[] = [];
  const averageWeight = (() => {
    const totalDegree = Array.from(tokenStats.values()).reduce((acc, cur) => acc + cur.degree, 0);
    if (totalDegree === 0) return 0;
    const sum = Array.from(tokenStats.values()).reduce((acc, cur) => acc + cur.weightSum, 0);
    return sum / totalDegree;
  })();

  const maxDegree = Math.max(1, ...Array.from(tokenStats.values()).map(stats => stats.degree));
  const maxSymbolEdges = Math.max(1, ...Array.from(tokenStats.values()).map(stats => stats.symbolEdges));
  const maxWeight = Math.max(1, ...Array.from(tokenStats.values()).map(stats => stats.weightSum));

  for (const token of result.tokens ?? []) {
    const normalized = typeof token.t === 'string' ? token.t : String(token || '');
    const key = normalized.toLowerCase();
    const stats = tokenStats.get(key) || { degree: 0, weightSum: 0, symbolEdges: 0 };
    const vector = [
      maxDegree ? stats.degree / maxDegree : 0,
      maxSymbolEdges ? stats.symbolEdges / maxSymbolEdges : 0,
      maxWeight ? stats.weightSum / maxWeight : 0,
      metrics.symbolDensity || 0,
    ];
    embeddings.push({ token: normalized, vector, updatedAt: now });
  }

  return {
    embeddings,
    globalMetrics: {
      symbolDensity: metrics.symbolDensity || 0,
      averageWeight,
    },
  };
}

export class VectorSemanticStore {
  private embeddings = new Map<string, TokenEmbedding>();
  private listeners = new Set<(embedding: TokenEmbedding) => void>();

  update(summary: EmbeddingSummary): void {
    for (const embedding of summary.embeddings) {
      const key = embedding.token.toLowerCase();
      this.embeddings.set(key, embedding);
      for (const listener of this.listeners) {
        listener(embedding);
      }
    }
  }

  get(token: string): TokenEmbedding | null {
    if (!token) return null;
    const embedding = this.embeddings.get(token.toLowerCase());
    return embedding ?? null;
  }

  toJSON(): TokenEmbedding[] {
    return Array.from(this.embeddings.values());
  }

  onUpdate(listener: (embedding: TokenEmbedding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
