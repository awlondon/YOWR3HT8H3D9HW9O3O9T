import { computeCosineSimilarity } from '../vector/similarity.js';
import type { CacheStore } from '../lib/storage/cacheStore.js';
import { resolveAdjacencySettings } from '../settings.js';
import type { PipelineGraph } from './pipeline.js';

const TOKEN_CACHE_PREFIX = 'hlsf_token_';

interface CachedAdjacencyRecord {
  token?: string;
  relationships?: Record<string, Array<{ token?: string; weight?: number }>>;
}

interface CachedNeighbor {
  token: string;
  weight: number;
  relation?: string;
}

const normalizeToken = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const lowerKey = (value: string): string => value.toLowerCase();

function safeParseRecord(raw: unknown): CachedAdjacencyRecord | null {
  if (!raw) return null;
  if (typeof raw === 'object') {
    return raw as CachedAdjacencyRecord;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as CachedAdjacencyRecord;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function readCachedAdjacencyRecord(
  token: string,
  store: CacheStore<unknown>,
): CachedAdjacencyRecord | null {
  const normalized = normalizeToken(token);
  if (!normalized) return null;
  const lower = lowerKey(normalized);
  const keyCandidates = Array.from(
    new Set<string>([
      `${TOKEN_CACHE_PREFIX}${lower}`,
      `${TOKEN_CACHE_PREFIX}${normalized}`,
      lower,
      normalized,
    ]),
  );

  for (const key of keyCandidates) {
    const raw = store.get(key);
    const parsed = safeParseRecord(raw);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function gatherTopCachedNeighbors(
  token: string,
  store: CacheStore<unknown>,
  limit = 2,
): CachedNeighbor[] {
  const record = readCachedAdjacencyRecord(token, store);
  if (!record || !record.relationships) return [];

  const neighborWeights = new Map<string, CachedNeighbor>();

  for (const [relationKey, entries] of Object.entries(record.relationships)) {
    if (!Array.isArray(entries) || !entries.length) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const neighborToken = normalizeToken(entry.token);
      if (!neighborToken) continue;
      if (neighborToken.toLowerCase() === normalizeToken(token).toLowerCase()) continue;
      const weightValue = Number(entry.weight);
      const weight = Number.isFinite(weightValue) ? weightValue : 0;
      const key = lowerKey(neighborToken);
      const existing = neighborWeights.get(key);
      if (!existing || weight > existing.weight) {
        neighborWeights.set(key, {
          token: neighborToken,
          weight,
          relation: relationKey,
        });
      }
    }
  }

  const ranked = Array.from(neighborWeights.values())
    .sort((a, b) => {
      if (b.weight === a.weight) {
        return a.token.localeCompare(b.token);
      }
      return b.weight - a.weight;
    })
    .slice(0, Math.max(0, limit));

  return ranked;
}

export type Limits = {
  branchingFactor: number;
  maxNodes: number;
  maxEdges: number;
  maxRelationTypes: number;
  pruneWeightThreshold: number;
  maxLayers: number;
  maxDegreePerLayer: number[];
  similarityThreshold: number;
  strongSimilarityThreshold: number;
};

/**
 * Resolves adjacency and branching limits for the synthetic expansion pipeline stage.
 * @param cfg Arbitrary settings-like object containing numeric knobs.
 * @returns Fully-populated limit structure respecting device memory heuristics and clamps.
 * @remarks Ensures all numeric caps (maxNodes/maxEdges/etc.) stay within safe ranges for the
 * runtime profile so downstream stages do not exceed configured bounds.
 */
export function resolveLimitsFromSettings(cfg: any): Limits {
  const dm = (typeof navigator !== 'undefined' && (navigator as any).deviceMemory) || 8;
  const def =
    dm <= 4
      ? {
          branchingFactor: 2,
          maxNodes: 600,
          maxEdges: 1800,
          maxRelationTypes: 24,
          pruneWeightThreshold: 0.22,
          maxLayers: 3,
          maxDegreePerLayer: [4, 2, 1],
          similarityThreshold: 0.35,
          strongSimilarityThreshold: 0.85,
        }
      : dm >= 16
        ? {
            branchingFactor: 2,
            maxNodes: 3200,
            maxEdges: 12800,
            maxRelationTypes: 50,
            pruneWeightThreshold: 0.15,
            maxLayers: 4,
            maxDegreePerLayer: [6, 5, 4, 3],
            similarityThreshold: 0.26,
            strongSimilarityThreshold: 0.78,
          }
        : {
            branchingFactor: 2,
            maxNodes: 1600,
            maxEdges: 6400,
            maxRelationTypes: 40,
            pruneWeightThreshold: 0.18,
            maxLayers: 3,
            maxDegreePerLayer: [5, 3, 2],
            similarityThreshold: 0.3,
            strongSimilarityThreshold: 0.82,
          };
  const adjacency = resolveAdjacencySettings({
    maxAdjacencyLayers: cfg?.maxAdjacencyLayers ?? cfg?.maxLayers,
    maxAdjacencyDegreePerLayer:
      cfg?.maxAdjacencyDegreePerLayer ?? cfg?.maxDegreePerLayer ?? undefined,
    maxAdjacencyDegree: cfg?.maxAdjacencyDegree ?? cfg?.maxDegree,
    adjacencySimilarityThreshold: cfg?.adjacencySimilarityThreshold ?? cfg?.similarityThreshold,
    adjacencyStrongSimilarityThreshold:
      cfg?.adjacencyStrongSimilarityThreshold ?? cfg?.strongSimilarityThreshold,
  });
  const maxLayers = adjacency.maxAdjacencyLayers;
  const maxDegreePerLayer = [
    Number.POSITIVE_INFINITY,
    ...adjacency.maxAdjacencyDegreePerLayer,
  ];

  return {
    branchingFactor: Number(cfg?.branchingFactor ?? def.branchingFactor) || def.branchingFactor,
    maxNodes: Number(cfg?.maxNodes ?? def.maxNodes) || def.maxNodes,
    maxEdges: Number(cfg?.maxEdges ?? def.maxEdges) || def.maxEdges,
    maxRelationTypes: Number(cfg?.maxRelationTypes ?? def.maxRelationTypes) || def.maxRelationTypes,
    pruneWeightThreshold:
      Number(cfg?.pruneWeightThreshold ?? def.pruneWeightThreshold) || def.pruneWeightThreshold,
    maxLayers,
    maxDegreePerLayer,
    similarityThreshold: adjacency.adjacencySimilarityThreshold,
    strongSimilarityThreshold: adjacency.adjacencyStrongSimilarityThreshold,
  };
}

function generateChildrenForToken(token: string, n: number, rng: () => number = Math.random): string[] {
  const base = String(token || '').trim();
  const out: string[] = [];
  const suffixes = ['·α', '·β', '·γ', '·δ', '·ε', '-1', '-2', 's', 'ing'];
  for (const s of suffixes) {
    if (out.length >= n) break;
    const cand = base + s;
    if (cand !== base) out.push(cand);
  }
  while (out.length < n) {
    out.push(base + '·' + rng().toString(36).slice(2, 5));
  }
  return out.slice(0, n);
}

/**
 * Approximates connectivity for a graph treated as undirected to ensure the synthetic
 * branching stage can stop once all nodes are mutually reachable.
 * @param nodes Pipeline nodes collection.
 * @param edges Pipeline edges collection.
 * @returns True when every node is connected (undirected) via provided edges.
 */
export function stronglyConnectedFromEdges(
  nodes: Array<{ token: string }>,
  edges: Array<{ source: string; target: string }>,
): boolean {
  const nodeSet = new Set(nodes.map((n) => n.token));
  if (nodeSet.size <= 1) return true;
  const adj: Record<string, Set<string>> = Object.create(null);
  for (const t of nodeSet) adj[t] = new Set();
  for (const e of edges) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    adj[e.source].add(e.target);
    adj[e.target].add(e.source); // undirected approximation
  }
  const start = nodeSet.values().next().value as string;
  const seen = new Set<string>([start]);
  const q = [start];
  while (q.length) {
    const cur = q.shift()!;
    for (const nb of adj[cur])
      if (!seen.has(nb)) {
        seen.add(nb);
        q.push(nb);
      }
  }
  return seen.size === nodeSet.size;
}

/**
 * Expands a seed list using cached adjacency relationships and deterministic fallback children.
 * @param nodes Mutable pipeline nodes collection that will be appended to.
 * @param acc Edge accumulator containing the graph's edges array.
 * @param seeds Seed tokens used for exploration.
 * @param limits Precomputed bounds for node/edge counts and similarity thresholds.
 * @param cacheStore Cache store providing cached adjacency records.
 * @param rng Optional deterministic number generator used for fallback child creation.
 */
export function syntheticBranchingExpansion(
  nodes: PipelineGraph['nodes'],
  acc: any,
  seeds: string[],
  limits: Limits,
  cacheStore: CacheStore<unknown>,
  rng?: () => number,
) {
  const seen = new Set(nodes.map((n) => n.token.toLowerCase()));
  const queue = seeds.map((token) => normalizeToken(token)).filter(Boolean);
  const edgeKeys = new Set<string>();
  for (const edge of acc.edges as Array<{ source?: string; target?: string; type?: string }>) {
    const key = `${edge.source || ''}->${edge.target || ''}|${edge.type || ''}`;
    edgeKeys.add(key);
  }

  const addNode = (token: string, weight: number): boolean => {
    const normalized = normalizeToken(token);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    if (seen.has(lower)) return false;
    if (nodes.length >= limits.maxNodes) return false;
    seen.add(lower);
    const safeWeight = Number.isFinite(weight) ? Math.max(0.5, Math.abs(weight)) : 1;
    nodes.push({
      token: normalized,
      kind: 'word',
      rawScore: safeWeight,
      index: nodes.length,
      cat: null,
    });
    return true;
  };

  const addEdge = (
    source: string,
    target: string,
    type: string,
    weight: number,
    meta: Record<string, unknown>,
  ) => {
    if (!source || !target) return;
    const key = `${source}->${target}|${type}`;
    if (edgeKeys.has(key)) return;
    if (acc.edges.length >= limits.maxEdges) return;
    edgeKeys.add(key);
    const safeWeight = Number.isFinite(weight) ? weight : 0;
    acc.edges.push({ source, target, type, w: safeWeight, meta });
  };

  const effectiveRng = rng ?? Math.random;

  while (queue.length) {
    if (nodes.length >= limits.maxNodes || acc.edges.length >= limits.maxEdges) break;
    const parent = queue.shift()!;
    const cachedNeighbors = gatherTopCachedNeighbors(
      parent,
      cacheStore,
      Math.max(2, limits.branchingFactor),
    );
    const addedNeighbors: CachedNeighbor[] = [];
    let attachedSemanticNeighbor = false;

    if (cachedNeighbors.length) {
      for (const neighbor of cachedNeighbors) {
        if (nodes.length >= limits.maxNodes || acc.edges.length >= limits.maxEdges) break;
        const normalizedNeighbor = normalizeToken(neighbor.token);
        if (!normalizedNeighbor) continue;
        const similarity = computeCosineSimilarity(parent, neighbor.token);
        if (similarity < limits.similarityThreshold) {
          continue;
        }

        const neighborWeight = Math.max(similarity, neighbor.weight || 0);
        const wasAdded = addNode(neighbor.token, neighborWeight || 1);
        if (wasAdded) {
          if (!queue.includes(normalizedNeighbor)) {
            queue.push(normalizedNeighbor);
          }
          addedNeighbors.push(neighbor);
        } else {
          addedNeighbors.push(neighbor);
        }
        attachedSemanticNeighbor = true;
        addEdge(parent, normalizedNeighbor, 'adjacency:cached', neighborWeight, {
          synthetic: true,
          source: 'cached-adjacency',
          relation: neighbor.relation || null,
          similarity,
          level: 1,
        });
        addEdge(normalizedNeighbor, parent, 'adjacency:cached', neighborWeight, {
          synthetic: true,
          source: 'cached-adjacency',
          relation: neighbor.relation || null,
          similarity,
          level: 1,
        });
      }

      for (let i = 0; i < addedNeighbors.length - 1; i += 1) {
        if (acc.edges.length >= limits.maxEdges) break;
        const a = normalizeToken(addedNeighbors[i]?.token);
        const b = normalizeToken(addedNeighbors[i + 1]?.token);
        if (!a || !b) continue;
        const similarityA = computeCosineSimilarity(
          addedNeighbors[i]!.token,
          addedNeighbors[i + 1]!.token,
        );
        if (similarityA < limits.similarityThreshold) continue;
        const bridgeWeight = Math.max(
          similarityA,
          Math.min(addedNeighbors[i]?.weight ?? 0, addedNeighbors[i + 1]?.weight ?? 0),
        );
        addEdge(a, b, 'adjacency:cached-bridge', bridgeWeight, {
          synthetic: true,
          source: 'cached-adjacency-bridge',
          similarity: similarityA,
          level: 1,
        });
        addEdge(b, a, 'adjacency:cached-bridge', bridgeWeight, {
          synthetic: true,
          source: 'cached-adjacency-bridge',
          similarity: similarityA,
          level: 1,
        });
      }
    }

    if (!attachedSemanticNeighbor) {
      const kids = generateChildrenForToken(parent, limits.branchingFactor, effectiveRng);
      for (const k of kids) {
        if (!seen.has(k.toLowerCase())) {
          addNode(k, 1);
          if (!queue.includes(k)) {
            queue.push(k);
          }
        }
        addEdge(parent, k, 'seed-expansion', 1, { synthetic: true, similarity: 0, level: 1 });
        addEdge(k, parent, 'seed-expansion', 1, { synthetic: true, similarity: 0, level: 1 });
        if (nodes.length >= limits.maxNodes || acc.edges.length >= limits.maxEdges) break;
      }
    }

    if (stronglyConnectedFromEdges(nodes, acc.edges)) break;
  }
}
