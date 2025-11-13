import { SETTINGS, type Settings } from '../settings.js';
import {
  tokenizeWithSymbols,
  tokenizeWords,
  type Token,
  computeWordNeighborMap,
} from '../tokens/tokenize.js';
import { emitSymbolEdges } from '../features/graph/symbolEdges.js';
import {
  buildLayeredAdjacency,
  type LayeredAdjacencyEdge,
  type LayeredExpansionOptions,
} from '../features/graph/layeredAdjacency.js';
import { computeCosineSimilarity } from '../vector/similarity.js';
import { rankNodes } from '../analytics/metrics.js';
import { emitPipelineTelemetry } from '../analytics/telemetry.js';
import type { PipelineStage, TelemetryHook } from '../types/pipeline-messages.js';
import { buildConsciousnessState, type ConsciousnessState } from './consciousness.js';
import {
  type CacheStore,
  CompositeCacheStore,
  LocalStorageStore,
  MemoryStore,
  wrapCacheLike,
} from '../lib/storage/cacheStore.js';

const TOKEN_CACHE_PREFIX = 'hlsf_token_';

export interface PipelineRunHooks {
  telemetry?: TelemetryHook;
  shouldAbort?: () => boolean;
  cacheStore?: CacheStore<unknown>;
}

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

let defaultCacheStore: CacheStore<unknown> | null = null;

function resolveDefaultCacheStore(): CacheStore<unknown> {
  if (defaultCacheStore) {
    return defaultCacheStore;
  }
  const stores: CacheStore<unknown>[] = [];
  const globalCache = wrapCacheLike<unknown>((globalThis as any).__HLSF_ADJ_CACHE__);
  if (globalCache) {
    stores.push(globalCache);
  }

  const storage: Storage | null = (() => {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    const globalStorage = (globalThis as any).localStorage;
    if (globalStorage && typeof globalStorage.getItem === 'function') {
      return globalStorage as Storage;
    }
    return null;
  })();

  if (storage) {
    stores.push(new LocalStorageStore(storage));
  }

  if (!stores.length) {
    defaultCacheStore = new MemoryStore<unknown>();
  } else if (stores.length === 1) {
    defaultCacheStore = stores[0];
  } else {
    defaultCacheStore = new CompositeCacheStore(stores);
  }

  return defaultCacheStore;
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

/** ===== Synthetic branching expansion helpers (guaranteed growth from 1 token) ===== */

type Limits = {
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

function resolveLimitsFromSettings(cfg: any): Limits {
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
  const maxLayers = Math.max(
    1,
    Number(cfg?.maxAdjacencyLayers ?? cfg?.maxLayers ?? def.maxLayers ?? 3) || 3,
  );
  const rawDegree = Array.isArray(cfg?.maxAdjacencyDegreePerLayer)
    ? cfg.maxAdjacencyDegreePerLayer.map((value: unknown) => Number(value) || 0)
    : Array.isArray(def.maxDegreePerLayer)
      ? def.maxDegreePerLayer.slice()
      : [Number(cfg?.maxAdjacencyDegree ?? cfg?.maxDegree ?? 4) || 4];
  const maxDegreePerLayer = Array.from({ length: maxLayers + 1 }, (_, index) => {
    if (index === 0) return Number.POSITIVE_INFINITY;
    const value = rawDegree[index - 1] ?? rawDegree[rawDegree.length - 1] ?? 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  });

  return {
    branchingFactor: Number(cfg?.branchingFactor ?? def.branchingFactor) || def.branchingFactor,
    maxNodes: Number(cfg?.maxNodes ?? def.maxNodes) || def.maxNodes,
    maxEdges: Number(cfg?.maxEdges ?? def.maxEdges) || def.maxEdges,
    maxRelationTypes: Number(cfg?.maxRelationTypes ?? def.maxRelationTypes) || def.maxRelationTypes,
    pruneWeightThreshold:
      Number(cfg?.pruneWeightThreshold ?? def.pruneWeightThreshold) || def.pruneWeightThreshold,
    maxLayers,
    maxDegreePerLayer,
    similarityThreshold: Math.max(
      0,
      Math.min(1, Number(cfg?.adjacencySimilarityThreshold ?? cfg?.similarityThreshold ?? 0.3)),
    ),
    strongSimilarityThreshold: Math.max(
      0,
      Math.min(
        1,
        Number(
          cfg?.adjacencyStrongSimilarityThreshold ??
            cfg?.strongSimilarityThreshold ??
            Math.max(0.8, Number(cfg?.adjacencySimilarityThreshold ?? 0.3) + 0.4),
        ),
      ),
    ),
  };
}

function generateChildrenForToken(token: string, n: number): string[] {
  const base = String(token || '').trim();
  const out: string[] = [];
  const suffixes = ['·α', '·β', '·γ', '·δ', '·ε', '-1', '-2', 's', 'ing'];
  for (const s of suffixes) {
    if (out.length >= n) break;
    const cand = base + s;
    if (cand !== base) out.push(cand);
  }
  while (out.length < n) {
    out.push(base + '·' + Math.random().toString(36).slice(2, 5));
  }
  return out.slice(0, n);
}

function stronglyConnectedFromEdges(
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

function syntheticBranchingExpansion(
  nodes: PipelineGraph['nodes'],
  acc: any,
  seeds: string[],
  limits: Limits,
  cacheStore: CacheStore<unknown>,
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
      const kids = generateChildrenForToken(parent, limits.branchingFactor);
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
export interface PipelineGraph {
  nodes: Array<{
    token: string;
    kind: string;
    rawScore: number;
    index: number;
    cat?: string | null;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    w: number;
    meta?: Record<string, unknown>;
  }>;
}

export interface PipelineResult {
  tokens: Token[];
  graph: PipelineGraph;
  edges: PipelineGraph['edges'];
  metrics: {
    tokenCount: number;
    wordCount: number;
    symbolCount: number;
    symbolDensity: number;
    edgeCount: number;
    symbolEdgeCount: number;
    weightSum: number;
  };
  top: PipelineGraph['nodes'];
  consciousness: ConsciousnessState;
}

export function legacyTokenizeDetailed(source: string): Token[] {
  return tokenizeWords(source).map((token) => ({ ...token, kind: 'word' as const }));
}

function buildGraphNodes(tokens: Token[]): PipelineGraph['nodes'] {
  return tokens.map((tok, index) => ({
    token: tok.t,
    kind: tok.kind,
    rawScore: tok.kind === 'word' ? Math.max(1, tok.n) : 0.5,
    index,
    cat: tok.cat ?? null,
  }));
}

interface EdgeProps {
  type: string;
  w?: number;
  meta?: Record<string, unknown>;
}

function createEdgeAccumulator(tokens: Token[], symbolEdgeLimit: number) {
  const edges: PipelineGraph['edges'] = [];
  const edgeHistogram: Record<string, number> = Object.create(null);
  let symbolEdgeCount = 0;
  let weightSum = 0;

  const push = (source: Token | undefined, target: Token | undefined, props: EdgeProps) => {
    if (!source || !target) return;

    const isModifierEdge = typeof props.type === 'string' && props.type.startsWith('modifier');
    if (isModifierEdge && symbolEdgeCount >= symbolEdgeLimit) return;

    const weight = typeof props.w === 'number' ? props.w : 0;
    const entry = {
      source: source.t,
      target: target.t,
      type: props.type,
      w: weight,
      meta: props.meta,
    };

    edges.push(entry);

    if (isModifierEdge) {
      symbolEdgeCount += 1;
    }

    if (typeof weight === 'number' && Number.isFinite(weight)) {
      weightSum += weight;
    }

    if (entry.type) {
      edgeHistogram[entry.type] = (edgeHistogram[entry.type] || 0) + 1;
    }
  };

  return {
    edges,
    edgeHistogram,
    get symbolEdgeCount() {
      return symbolEdgeCount;
    },
    get weightSum() {
      return weightSum;
    },
    addEdgeByTokens(source: Token, target: Token, props: EdgeProps) {
      push(source, target, props);
    },
    addEdgeByIndices(sourceIndex: number, targetIndex: number, props: EdgeProps) {
      push(tokens[sourceIndex], tokens[targetIndex], props);
    },
  };
}

function buildChunkedAdjacency(
  tokens: Token[],
  chunkSize: number,
  options: LayeredExpansionOptions,
): LayeredAdjacencyEdge[] {
  const total = tokens.length;
  if (total < 2) {
    return [];
  }

  const normalizedSize = Math.max(1, Math.floor(Number.isFinite(chunkSize) ? chunkSize : 1));
  if (normalizedSize <= 1 || normalizedSize >= total) {
    return buildLayeredAdjacency(tokens, options);
  }

  const edges: LayeredAdjacencyEdge[] = [];

  for (let start = 0, chunkIndex = 0; start < total; start += normalizedSize, chunkIndex += 1) {
    const end = Math.min(total, start + normalizedSize);
    if (end - start < 2) {
      continue;
    }

    const chunkEdges = buildLayeredAdjacency(tokens.slice(start, end), options);
    for (const edge of chunkEdges) {
      edges.push({
        ...edge,
        sourceIndex: edge.sourceIndex + start,
        targetIndex: edge.targetIndex + start,
        meta: { ...edge.meta, chunkIndex, chunkOffset: start },
      });
    }
  }

  if (!edges.length) {
    return buildLayeredAdjacency(tokens, options);
  }

  return edges;
}

export function runPipeline(
  input: string,
  cfg: Settings = SETTINGS,
  hooks: PipelineRunHooks = {},
): PipelineResult {
  const telemetry = hooks.telemetry;
  const hasPerformanceNow =
    typeof performance !== 'undefined' && typeof performance.now === 'function';
  const now = hasPerformanceNow ? () => performance.now() : () => Date.now();
  const stageStartTimes = new Map<PipelineStage, number>();
  const cacheStore = hooks.cacheStore ?? resolveDefaultCacheStore();

  const ensureNotAborted = () => {
    if (hooks.shouldAbort?.()) {
      const error = new Error('Pipeline aborted');
      error.name = 'AbortError';
      throw error;
    }
  };

  const startStage = (stage: PipelineStage) => {
    ensureNotAborted();
    stageStartTimes.set(stage, now());
    telemetry?.onStage?.(stage, 0);
  };

  const finishStage = (stage: PipelineStage, meta?: Record<string, unknown>) => {
    const startedAt = stageStartTimes.get(stage);
    const duration = typeof startedAt === 'number' ? Math.max(0, now() - startedAt) : undefined;
    const enrichedMeta = duration != null ? { ...(meta ?? {}), durationMs: duration } : meta;
    telemetry?.onStage?.(stage, 1, enrichedMeta);
  };

  const guardedLoopCheck = (index: number) => {
    if ((index & 63) === 0) {
      ensureNotAborted();
    }
  };

  startStage('tokenize');
  const tokens = cfg.tokenizeSymbols ? tokenizeWithSymbols(input) : legacyTokenizeDetailed(input);
  const nodes = buildGraphNodes(tokens);

  let wordCount = 0;
  let symbolCount = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    guardedLoopCheck(i);
    const token = tokens[i];
    if (!token) continue;
    if (token.kind === 'sym') {
      symbolCount += 1;
    } else {
      wordCount += 1;
    }
  }
  finishStage('tokenize', {
    tokenCount: tokens.length,
    wordCount,
    symbolCount,
  });

  const symbolEdgeLimit =
    symbolCount === 0 ? 0 : Math.max(symbolCount * 4, Math.ceil(tokens.length * 0.6));

  const accumulator = createEdgeAccumulator(tokens, symbolEdgeLimit);

  startStage('adjacency');
  if (cfg.tokenizeSymbols) {
    const neighborMap = computeWordNeighborMap(tokens);
    emitSymbolEdges(
      tokens,
      (source, target, props) => accumulator.addEdgeByTokens(source, target, props),
      cfg.symbolWeightScale,
      cfg.symbolEmitMode,
      neighborMap,
    );
  }

  const adjacencyChunkSize = Math.max(1, Math.floor(cfg.promptAdjacencyChunkSize ?? 8));
  const adjacencyOptions: LayeredExpansionOptions = {
    maxDepth: cfg.maxAdjacencyDepth,
    maxDegree: cfg.maxAdjacencyDegree,
    maxLayers: cfg.maxAdjacencyLayers,
    maxDegreePerLayer: cfg.maxAdjacencyDegreePerLayer,
    similarityThreshold: cfg.adjacencySimilarityThreshold,
    strongSimilarityThreshold: cfg.adjacencyStrongSimilarityThreshold,
    maxEdges: Math.max(
      tokens.length,
      Math.floor((cfg.maxAdjacencyEdgesMultiplier ?? 6) * tokens.length),
    ),
  };
  const adjacencyEdges = buildChunkedAdjacency(tokens, adjacencyChunkSize, adjacencyOptions);
  for (let i = 0; i < adjacencyEdges.length; i += 1) {
    guardedLoopCheck(i);
    const edge = adjacencyEdges[i];
    accumulator.addEdgeByIndices(edge.sourceIndex, edge.targetIndex, {
      type: edge.type,
      w: edge.weight,
      meta: edge.meta,
    });
  }
  finishStage('adjacency', { edgeCount: accumulator.edges.length });

  startStage('propagate');
  try {
    const limits = resolveLimitsFromSettings(cfg);
    const currentEdgeCount = accumulator.edges.length;
    if (tokens.length <= 1 || currentEdgeCount === 0) {
      const firstToken = tokens[0];
      const seedText = firstToken ? String(firstToken.t ?? '') : '';
      const seeds = seedText ? [seedText] : [];
      if (seeds.length) {
        syntheticBranchingExpansion(nodes, accumulator, seeds, limits, cacheStore);
      }
    }
  } catch (e) {
    console.warn('Synthetic branching expansion skipped:', e);
  }
  finishStage('propagate', { nodeCount: nodes.length, edgeCount: accumulator.edges.length });

  const { edges, edgeHistogram, symbolEdgeCount, weightSum } = accumulator;

  startStage('prune');
  try {
    ensureNotAborted();
    const limits = resolveLimitsFromSettings(cfg);
    edges.sort((a, b) => (a.w ?? 0) - (b.w ?? 0));
    while (edges.length > limits.maxEdges) {
      ensureNotAborted();
      if (!edges.length) break;
      const candidate = edges[0];
      if ((candidate.w ?? 0) > limits.pruneWeightThreshold) break;
      edges.shift();
    }
    const connected = new Set<string>();
    for (let i = 0; i < edges.length; i += 1) {
      guardedLoopCheck(i);
      const e = edges[i];
      if (e.source) connected.add(e.source);
      if (e.target) connected.add(e.target);
    }
    if (nodes.length > limits.maxNodes) {
      const keep = nodes.filter((n) => n?.token && connected.has(n.token));
      if (keep.length) {
        nodes.length = 0;
        nodes.push(...keep.slice(0, limits.maxNodes));
      } else {
        nodes.length = limits.maxNodes;
      }
    }
  } catch (e) {
    console.warn('Prune-to-limits skipped:', e);
  }
  finishStage('prune', { edgeCount: edges.length, nodeCount: nodes.length });

  startStage('rank');
  const top = rankNodes(nodes, 20);
  finishStage('rank', { topCount: top.length });

  startStage('finalize');
  const metrics = {
    tokenCount: tokens.length,
    wordCount,
    symbolCount,
    symbolDensity: tokens.length === 0 ? 0 : symbolCount / tokens.length,
    edgeCount: edges.length,
    symbolEdgeCount,
    weightSum,
  };

  const graph: PipelineGraph = { nodes, edges };
  const consciousness = buildConsciousnessState(tokens, graph);

  if (cfg.tokenizeSymbols) {
    emitPipelineTelemetry({
      metrics,
      edgeHistogram,
      top,
      settings: {
        tokenizeSymbols: cfg.tokenizeSymbols,
        symbolWeightScale: cfg.symbolWeightScale,
        symbolEmitMode: cfg.symbolEmitMode,
        includeSymbolInSummaries: cfg.includeSymbolInSummaries,
      },
      consciousness,
    });
  }
  finishStage('finalize', {
    edgeCount: edges.length,
    nodeCount: nodes.length,
  });

  ensureNotAborted();

  return {
    tokens,
    graph,
    edges,
    metrics,
    top,
    consciousness,
  };
}
