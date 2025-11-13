import type { Token } from '../tokens/tokenize.js';

const embeddingRegistry = new Map<string, Float32Array>();
const similarityCache = new Map<string, number>();
let fetchers: Array<(token: string) => Float32Array | null | undefined> = [];

function normalizeToken(token: string): string {
  return token?.trim().toLowerCase() ?? '';
}

function normalizeVector(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i];
    sumSquares += value * value;
  }
  if (!sumSquares || !Number.isFinite(sumSquares)) {
    return vector.slice();
  }
  const norm = Math.sqrt(sumSquares);
  if (!norm) {
    return vector.slice();
  }
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    out[i] = vector[i] / norm;
  }
  return out;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}#${b}` : `${b}#${a}`;
}

function clearSimilarityCacheFor(token: string): void {
  const suffix = `#${token}`;
  for (const key of similarityCache.keys()) {
    if (key.includes(suffix)) {
      similarityCache.delete(key);
    }
  }
}

function resolveFromGlobalCache(token: string): Float32Array | null {
  const globalCache = (globalThis as any).__HLSF_EMBEDDINGS__;
  if (!globalCache) {
    return null;
  }
  if (globalCache instanceof Map) {
    const match = globalCache.get(token) ?? globalCache.get(token.toLowerCase());
    if (match instanceof Float32Array) {
      return match.slice();
    }
    if (Array.isArray(match)) {
      return new Float32Array(match);
    }
    if (match && typeof match === 'object' && Array.isArray((match as any).vector)) {
      return new Float32Array((match as any).vector);
    }
  }
  if (typeof globalCache === 'object') {
    const match = globalCache[token] ?? globalCache[token.toLowerCase?.()];
    if (match instanceof Float32Array) {
      return match.slice();
    }
    if (Array.isArray(match)) {
      return new Float32Array(match);
    }
  }
  return null;
}

function tryFetch(token: string): Float32Array | null {
  for (const fetcher of fetchers) {
    try {
      const result = fetcher(token);
      if (result instanceof Float32Array) {
        return result;
      }
      if (Array.isArray(result)) {
        return new Float32Array(result as number[]);
      }
    } catch (error) {
      console.warn('similarity fetcher failed', error);
    }
  }
  return resolveFromGlobalCache(token);
}

function resolveEmbedding(token: string): Float32Array | null {
  const normalized = normalizeToken(token);
  if (!normalized) {
    return null;
  }
  const cached = embeddingRegistry.get(normalized);
  if (cached) {
    return cached;
  }
  const fetched = tryFetch(token);
  if (!fetched) {
    return null;
  }
  const normalizedVector = normalizeVector(fetched);
  embeddingRegistry.set(normalized, normalizedVector);
  clearSimilarityCacheFor(normalized);
  return normalizedVector;
}

export function registerEmbedding(token: string, vector: Float32Array | number[]): void {
  const normalized = normalizeToken(token);
  if (!normalized) return;
  const payload = vector instanceof Float32Array ? vector : new Float32Array(vector);
  embeddingRegistry.set(normalized, normalizeVector(payload));
  clearSimilarityCacheFor(normalized);
}

export function registerEmbeddingFetcher(fn: (token: string) => Float32Array | null | undefined): void {
  if (typeof fn !== 'function') return;
  fetchers = [fn, ...fetchers];
}

export function clearRegisteredEmbeddings(): void {
  embeddingRegistry.clear();
  similarityCache.clear();
}

export function computeCosineSimilarityFromTokens(a: Token | undefined, b: Token | undefined): number {
  if (!a?.t || !b?.t) {
    return 0;
  }
  return computeCosineSimilarity(a.t, b.t);
}

export function computeCosineSimilarity(tokenA: string, tokenB: string): number {
  const a = normalizeToken(tokenA);
  const b = normalizeToken(tokenB);
  if (!a || !b || a === b) {
    return a === b ? 1 : 0;
  }
  const key = pairKey(a, b);
  const cached = similarityCache.get(key);
  if (typeof cached === 'number') {
    return cached;
  }
  const vecA = resolveEmbedding(tokenA);
  const vecB = resolveEmbedding(tokenB);
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) {
    similarityCache.set(key, 0);
    return 0;
  }
  const length = Math.min(vecA.length, vecB.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += vecA[i] * vecB[i];
  }
  const clamped = Math.max(-1, Math.min(1, dot));
  similarityCache.set(key, clamped);
  return clamped;
}

export function topSimilarTokens(tokens: Token[], index: number, minScore: number, limit = 5): Array<{ index: number; score: number }> {
  const origin = tokens[index];
  if (!origin) return [];
  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (i === index) continue;
    const score = computeCosineSimilarityFromTokens(origin, tokens[i]);
    if (score >= minScore) {
      scored.push({ index: i, score });
    }
  }
  return scored
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .slice(0, Math.max(0, limit));
}
