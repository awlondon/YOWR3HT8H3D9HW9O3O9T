export enum AdjacencyFamily {
  Spatial = 'spatial',
  Temporal = 'temporal',
  Causal = 'causal',
  Hierarchical = 'hierarchical',
  Analogical = 'analogical',
  Constraint = 'constraint',
  Value = 'value',
  Communicative = 'communicative',
  Social = 'social',
  Modal = 'modal',
  Evidential = 'evidential',
  Counterfactual = 'counterfactual',
  Operational = 'operational',
  Measurement = 'measurement',
  Aesthetic = 'aesthetic',
}

export const RELATION_FAMILY_MAP: Record<string, AdjacencyFamily> = {
  proximity: AdjacencyFamily.Spatial,
  containment: AdjacencyFamily.Spatial,
  overlap: AdjacencyFamily.Spatial,
  path: AdjacencyFamily.Spatial,
  barrier: AdjacencyFamily.Spatial,
  'adjacency:base': AdjacencyFamily.Spatial,
  'adjacency:cached': AdjacencyFamily.Spatial,
  'adjacency:cached-bridge': AdjacencyFamily.Spatial,
  'adjacency:layer:1': AdjacencyFamily.Spatial,
  'adjacency:layer:2': AdjacencyFamily.Spatial,
  'adjacency:layer:3': AdjacencyFamily.Spatial,
  'adjacency:layer:4': AdjacencyFamily.Spatial,
  'adjacency:layer:5': AdjacencyFamily.Spatial,
  'skg-base': AdjacencyFamily.Operational,
  'skg-cross-level': AdjacencyFamily.Operational,
  before: AdjacencyFamily.Temporal,
  after: AdjacencyFamily.Temporal,
  during: AdjacencyFamily.Temporal,
  recurrence: AdjacencyFamily.Temporal,
  cause: AdjacencyFamily.Causal,
  effect: AdjacencyFamily.Causal,
  enablement: AdjacencyFamily.Causal,
  inhibition: AdjacencyFamily.Causal,
  '⇄': AdjacencyFamily.Causal,
  '⇝': AdjacencyFamily.Causal,
  '↼': AdjacencyFamily.Causal,
  'seed-expansion': AdjacencyFamily.Operational,
  'modifier:emphasis': AdjacencyFamily.Communicative,
  'modifier:query': AdjacencyFamily.Communicative,
  'modifier:left': AdjacencyFamily.Communicative,
  'modifier:right': AdjacencyFamily.Communicative,
  'modifier:close': AdjacencyFamily.Communicative,
  'modifier:other': AdjacencyFamily.Communicative,
  'self:symbol': AdjacencyFamily.Aesthetic,
};

export function classifyRelation(key: string): AdjacencyFamily {
  const lower = String(key || '').toLowerCase();
  if (RELATION_FAMILY_MAP[lower]) {
    return RELATION_FAMILY_MAP[lower];
  }
  if (lower.startsWith('adjacency:layer:')) return AdjacencyFamily.Spatial;
  if (lower.startsWith('adjacency:')) return AdjacencyFamily.Spatial;
  if (lower.startsWith('modifier:')) return AdjacencyFamily.Communicative;
  if (lower === '∼') return AdjacencyFamily.Spatial;
  return AdjacencyFamily.Aesthetic;
}
