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
import {
  resolveLimitsFromSettings,
  syntheticBranchingExpansion,
} from './syntheticExpansion.js';

export interface PipelineRunHooks {
  telemetry?: TelemetryHook;
  shouldAbort?: () => boolean;
  cacheStore?: CacheStore<unknown>;
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
