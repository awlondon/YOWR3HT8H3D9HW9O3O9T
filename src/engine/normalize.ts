import type { KnowledgeRecord } from './knowledgeStore';

// Include optional cached_at since app.ts writes to it.
export type NormalizedRecord = KnowledgeRecord & { cached_at?: string };

export function normalizeRecord(input: unknown): NormalizedRecord | null {
  if (!input) return null;

  // 1) Resolve token string
  let token = '';
  if (typeof input === 'string') {
    token = input.trim();
  } else if (typeof input === 'object') {
    const obj = input as any;
    if (typeof obj.token === 'string') token = obj.token.trim();
    else if (typeof obj.id === 'string') token = obj.id.trim();
  } else {
    return null;
  }
  if (!token) return null;

  const out: NormalizedRecord = { token };

  // 2) Relationships → { [relType]: Array<{ token, weight }> }
  if (typeof input === 'object' && input) {
    const obj = input as any;
    const rel = obj.relationships;
    if (rel && typeof rel === 'object') {
      const normalized: Record<string, Array<{ token: string; weight: number }>> = {};
      for (const [relType, edges] of Object.entries(rel)) {
        if (!Array.isArray(edges)) continue;
        const clean = edges
          .map((e: any) => ({
            token: typeof e?.token === 'string' ? e.token.trim() : '',
            weight: Number.isFinite(Number(e?.weight)) ? Number(e.weight) : 0,
          }))
          .filter(e => !!e.token);
        if (clean.length) normalized[relType] = clean;
      }
      if (Object.keys(normalized).length) (out as any).relationships = normalized;
    }

    // 3) Optional fields preserved if present
    if (obj.attention_score != null) out.attention_score = Number(obj.attention_score) || 0;
    if (obj.total_relationships != null) out.total_relationships = Number(obj.total_relationships) || 0;
    if (typeof obj.cached_at === 'string') (out as any).cached_at = obj.cached_at;
  }

  return out;
}
