export function embedTextToVector(text: string, dims = 24): number[] {
  const vec = new Array(dims).fill(0);
  const normalized = text || '';
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    vec[i % dims] += Math.sin(code) + Math.cos(code / 2);
  }
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / magnitude);
}

export function getEmbeddingStore(container: { metadata?: Record<string, unknown> }): Map<string, number[]> {
  const metadata = (container.metadata = container.metadata || {});
  const store = (metadata as any).embeddings as Map<string, number[]> | undefined;
  if (store instanceof Map) return store;
  const created = new Map<string, number[]>();
  (metadata as any).embeddings = created;
  return created;
}

export function getOrCreateEmbedding(
  container: { metadata?: Record<string, unknown> },
  id: string,
  label: string,
  hint?: number[],
  dims = 24,
): number[] {
  const embeddings = getEmbeddingStore(container);
  const existing = embeddings.get(id);
  if (existing?.length) return existing;
  const computed = hint && hint.length ? hint : embedTextToVector(label || id, dims);
  embeddings.set(id, computed);
  return computed;
}
