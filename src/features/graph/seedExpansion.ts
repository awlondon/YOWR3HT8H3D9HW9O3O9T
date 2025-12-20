import { AdjacencyFamily, classifyRelation } from '../../types/adjacencyFamilies.js';

export interface SeedExpansionNode {
  id: string;
  label: string;
  hintEmbedding?: number[];
  meta?: Record<string, unknown>;
}

export interface SeedExpansionEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  family: AdjacencyFamily;
  meta?: Record<string, unknown>;
}

export interface SeedExpansionTriangle {
  id: string;
  vertices: [string, string, string];
  baseId: string;
  level: number;
}

export interface SeedExpansionResult {
  nodes: SeedExpansionNode[];
  edges: SeedExpansionEdge[];
  triangles: SeedExpansionTriangle[];
}

const CORE_RELATIONSHIP_TYPES = [
  'temporal',
  'causal',
  'hierarchical',
  'analogical',
  'constraint',
  'value',
  'communicative',
  'operational',
];

const defaultEmbedding = (seed: string): number[] => {
  const basis = seed
    .toLowerCase()
    .split('')
    .map(char => ((char.charCodeAt(0) % 19) + 1) / 19);
  const dims = 8;
  const emb: number[] = [];
  for (let i = 0; i < dims; i += 1) {
    emb.push(basis[i % basis.length] ?? 0.05 * (i + 1));
  }
  const norm = Math.sqrt(emb.reduce((sum, value) => sum + value * value, 0)) || 1;
  return emb.map(value => value / norm);
};

function clampDimension(value: number | undefined): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return 8;
  return Math.max(4, numeric);
}

const edgeKey = (source: string, target: string, type: string): string => `${source}->${target}:${type}`;

/**
 * Builds a triangular seed expansion K_n scaffold anchored on a base node.
 * Each triangle uses the base node plus two emergent adjacency concepts and
 * shares boundary nodes with its neighbor to encourage lateral coherence.
 */
export function expandSeed(
  baseId: string,
  dimension = 8,
  baseLabel?: string,
  level = 1,
): SeedExpansionResult {
  const dim = clampDimension(dimension);
  const triangleCount = Math.max(0, Math.floor(dim / 2) - 1);
  if (!triangleCount) return { nodes: [], edges: [], triangles: [] };

  const emergentCount = triangleCount + 1;
  const nodes: SeedExpansionNode[] = [];
  for (let i = 0; i < emergentCount; i += 1) {
    const relation = CORE_RELATIONSHIP_TYPES[i % CORE_RELATIONSHIP_TYPES.length];
    const id = `${baseId}:seed:${i}`;
    const label = `${baseLabel ?? baseId} ${relation}`;
    nodes.push({
      id,
      label,
      hintEmbedding: defaultEmbedding(`${label}:${level}`),
      meta: { relation, level, kind: 'seed-adjacency' },
    });
  }

  const family = classifyRelation('seed-expansion');
  const edges: SeedExpansionEdge[] = [];
  const triangles: SeedExpansionTriangle[] = [];
  const seenEdges = new Set<string>();

  const pushEdge = (edge: SeedExpansionEdge) => {
    const key = edgeKey(edge.source, edge.target, edge.type);
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(edge);
  };

  for (let i = 0; i < triangleCount; i += 1) {
    const left = nodes[i];
    const right = nodes[i + 1];
    const triangleId = `${baseId}-triangle-${level}-${i}`;
    const weight = Math.max(0.2, 0.55 - i * 0.05);
    const sharedMeta = { triangleId, baseId, level };

    pushEdge({
      id: `${baseId}->${left.id}`,
      source: baseId,
      target: left.id,
      type: 'seed-expansion',
      weight,
      family,
      meta: { ...sharedMeta, role: 'anchor' },
    });
    pushEdge({
      id: `${baseId}->${right.id}`,
      source: baseId,
      target: right.id,
      type: 'seed-expansion',
      weight,
      family,
      meta: { ...sharedMeta, role: 'anchor' },
    });
    pushEdge({
      id: `${left.id}<->${right.id}`,
      source: left.id,
      target: right.id,
      type: 'seed-expansion',
      weight: Math.max(0.18, weight * 0.85),
      family,
      meta: { ...sharedMeta, role: 'lateral' },
    });

    triangles.push({ id: triangleId, vertices: [baseId, left.id, right.id], baseId, level });
  }

  return { nodes, edges, triangles };
}
