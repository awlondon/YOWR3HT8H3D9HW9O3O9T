export const REL_DEFAULT = 'meta';

const CANONICAL_REL_MAP: Record<string, string> = {
  cause: '⇒',
  effect: '⇒',
  influences: '⇒',
  leads_to: '⇒',
  leads: '⇒',
  impacts: '⇒',
  contextual: '∼',
  context: '∼',
  related: '∼',
  association: '∼',
  analogy: '≈',
  similar: '≈',
  resemblance: '≈',
  contrast: '⇔',
  opposes: '⇔',
  contradicts: '⇔',
  implies: '⇐',
  implied_by: '⇐',
  bidirectional: '⇄',
  symmetric: '⇄',
  member: '⊂',
  example: '⊂',
  instance: '⊂',
  meta: 'meta',
};

export function normalizeRelationship(rel: string | null | undefined): string {
  if (!rel) return REL_DEFAULT;
  const trimmed = rel.trim();
  if (!trimmed) return REL_DEFAULT;
  const lower = trimmed.toLowerCase();
  if (CANONICAL_REL_MAP[lower]) return CANONICAL_REL_MAP[lower];
  return trimmed;
}
