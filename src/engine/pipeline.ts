import { SETTINGS, type Settings } from '../settings.js';
import { tokenizeWithSymbols, tokenizeWords, type Token, computeWordNeighborMap } from '../tokens/tokenize.js';
import { emitSymbolEdges } from '../graph/symbol_edges.js';
import {
  buildRecursiveAdjacency,
  type RecursiveAdjacencyEdge,
  type RecursiveAdjacencyOptions,
} from '../graph/recursive_adjacency.js';
import { rankNodes } from '../analytics/metrics.js';
import { emitPipelineTelemetry } from '../analytics/telemetry.js';
import { buildConsciousnessState, type ConsciousnessState } from './consciousness.js';

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

function readCachedAdjacencyRecord(token: string): CachedAdjacencyRecord | null {
  const normalized = normalizeToken(token);
  if (!normalized) return null;
  const lower = lowerKey(normalized);

  const globalCache = (globalThis as any).__HLSF_ADJ_CACHE__;
  if (globalCache && typeof globalCache.get === 'function') {
    const record = globalCache.get(lower) ?? globalCache.get(normalized);
    const parsed = safeParseRecord(record);
    if (parsed) return parsed;
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
    const key = `${TOKEN_CACHE_PREFIX}${lower}`;
    try {
      const raw = storage.getItem(key);
      const parsed = safeParseRecord(raw);
      if (parsed) return parsed;
    } catch {
      // ignore storage access errors
    }
  }

  return null;
}

function gatherTopCachedNeighbors(token: string, limit = 2): CachedNeighbor[] {
  const record = readCachedAdjacencyRecord(token);
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
};

function resolveLimitsFromSettings(cfg: any): Limits {
  const dm = (typeof navigator !== 'undefined' && (navigator as any).deviceMemory) || 8;
  const def = dm <= 4 ? { branchingFactor: 2, maxNodes: 600,  maxEdges: 1800,  maxRelationTypes: 24, pruneWeightThreshold: 0.22 }
           : dm >= 16 ? { branchingFactor: 2, maxNodes: 3200, maxEdges: 12800, maxRelationTypes: 50, pruneWeightThreshold: 0.15 }
                       : { branchingFactor: 2, maxNodes: 1600, maxEdges: 6400,  maxRelationTypes: 40, pruneWeightThreshold: 0.18 };
  return {
    branchingFactor: Number(cfg?.branchingFactor ?? def.branchingFactor) || def.branchingFactor,
    maxNodes: Number(cfg?.maxNodes ?? def.maxNodes) || def.maxNodes,
    maxEdges: Number(cfg?.maxEdges ?? def.maxEdges) || def.maxEdges,
    maxRelationTypes: Number(cfg?.maxRelationTypes ?? def.maxRelationTypes) || def.maxRelationTypes,
    pruneWeightThreshold: Number(cfg?.pruneWeightThreshold ?? def.pruneWeightThreshold) || def.pruneWeightThreshold,
  };
}

function generateChildrenForToken(token: string, n: number): string[] {
  const base = String(token || '').trim();
  const out: string[] = [];
  const suffixes = ['·α','·β','·γ','·δ','·ε','-1','-2','s','ing'];
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

function stronglyConnectedFromEdges(nodes: Array<{token:string}>, edges: Array<{source:string,target:string}>): boolean {
  const nodeSet = new Set(nodes.map(n => n.token));
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
    for (const nb of adj[cur]) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  return seen.size === nodeSet.size;
}

function syntheticBranchingExpansion(nodes: PipelineGraph['nodes'], acc: any, seeds: string[], limits: Limits) {
  const seen = new Set(nodes.map(n => n.token.toLowerCase()));
  const queue = seeds.map(token => normalizeToken(token)).filter(Boolean);
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
    nodes.push({ token: normalized, kind: 'word', rawScore: safeWeight, index: nodes.length, cat: null });
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
    const cachedNeighbors = gatherTopCachedNeighbors(parent, Math.max(2, limits.branchingFactor));
    const addedNeighbors: CachedNeighbor[] = [];

    if (cachedNeighbors.length) {
      for (const neighbor of cachedNeighbors) {
        if (nodes.length >= limits.maxNodes || acc.edges.length >= limits.maxEdges) break;
        const wasAdded = addNode(neighbor.token, neighbor.weight || 1);
        const normalizedNeighbor = normalizeToken(neighbor.token);
        if (!normalizedNeighbor) continue;
        if (wasAdded) {
          if (!queue.includes(normalizedNeighbor)) {
            queue.push(normalizedNeighbor);
          }
          addedNeighbors.push(neighbor);
        } else {
          addedNeighbors.push(neighbor);
        }
        addEdge(parent, normalizedNeighbor, 'adjacency:cached', neighbor.weight || 0, {
          synthetic: true,
          source: 'cached-adjacency',
          relation: neighbor.relation || null,
        });
        addEdge(normalizedNeighbor, parent, 'adjacency:cached', neighbor.weight || 0, {
          synthetic: true,
          source: 'cached-adjacency',
          relation: neighbor.relation || null,
        });
      }

      for (let i = 0; i < addedNeighbors.length - 1; i += 1) {
        if (acc.edges.length >= limits.maxEdges) break;
        const a = normalizeToken(addedNeighbors[i]?.token);
        const b = normalizeToken(addedNeighbors[i + 1]?.token);
        if (!a || !b) continue;
        const bridgeWeight = Math.max(
          0,
          Math.min(addedNeighbors[i]?.weight ?? 0, addedNeighbors[i + 1]?.weight ?? 0),
        );
        addEdge(a, b, 'adjacency:cached-bridge', bridgeWeight, {
          synthetic: true,
          source: 'cached-adjacency-bridge',
        });
        addEdge(b, a, 'adjacency:cached-bridge', bridgeWeight, {
          synthetic: true,
          source: 'cached-adjacency-bridge',
        });
      }
    }

    if (!cachedNeighbors.length) {
      const kids = generateChildrenForToken(parent, limits.branchingFactor);
      for (const k of kids) {
        if (!seen.has(k.toLowerCase())) {
          addNode(k, 1);
          if (!queue.includes(k)) {
            queue.push(k);
          }
        }
        addEdge(parent, k, 'seed-expansion', 1, { synthetic: true });
        addEdge(k, parent, 'seed-expansion', 1, { synthetic: true });
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
  return tokenizeWords(source).map(token => ({ ...token, kind: 'word' as const }));
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
  options: RecursiveAdjacencyOptions,
): RecursiveAdjacencyEdge[] {
  const total = tokens.length;
  if (total < 2) {
    return [];
  }

  const normalizedSize = Math.max(1, Math.floor(Number.isFinite(chunkSize) ? chunkSize : 1));
  if (normalizedSize <= 1 || normalizedSize >= total) {
    return buildRecursiveAdjacency(tokens, options);
  }

  const edges: RecursiveAdjacencyEdge[] = [];

  for (let start = 0, chunkIndex = 0; start < total; start += normalizedSize, chunkIndex += 1) {
    const end = Math.min(total, start + normalizedSize);
    if (end - start < 2) {
      continue;
    }

    const chunkEdges = buildRecursiveAdjacency(tokens.slice(start, end), options);
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
    return buildRecursiveAdjacency(tokens, options);
  }

  return edges;
}

export function runPipeline(input: string, cfg: Settings = SETTINGS): PipelineResult {
  const tokens = cfg.tokenizeSymbols ? tokenizeWithSymbols(input) : legacyTokenizeDetailed(input);
  const nodes = buildGraphNodes(tokens);

  let wordCount = 0;
  let symbolCount = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (token.kind === 'sym') {
      symbolCount += 1;
    } else {
      wordCount += 1;
    }
  }

  const symbolEdgeLimit = symbolCount === 0
    ? 0
    : Math.max(symbolCount * 4, Math.ceil(tokens.length * 0.6));

  const accumulator = createEdgeAccumulator(tokens, symbolEdgeLimit);

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
  const adjacencyOptions: RecursiveAdjacencyOptions = {
    maxDepth: cfg.maxAdjacencyDepth,
    maxDegree: cfg.maxAdjacencyDegree,
    maxEdges: Math.max(
      tokens.length,
      Math.floor((cfg.maxAdjacencyEdgesMultiplier ?? 6) * tokens.length),
    ),
  };
  const adjacencyEdges = buildChunkedAdjacency(tokens, adjacencyChunkSize, adjacencyOptions);
  for (const edge of adjacencyEdges) {
    accumulator.addEdgeByIndices(edge.sourceIndex, edge.targetIndex, {
      type: edge.type,
      w: edge.weight,
      meta: edge.meta,
    });
  }

  // Ensure growth even for single-token prompts by synthetic branching
  try {
    const limits = resolveLimitsFromSettings(cfg);
    const currentEdgeCount = accumulator.edges.length;
    if (tokens.length <= 1 || currentEdgeCount === 0) {
      const firstToken = tokens[0];
      const seedText = firstToken ? String(firstToken.t ?? '') : '';
      const seeds = seedText ? [seedText] : [];
      if (seeds.length) {
        syntheticBranchingExpansion(nodes, accumulator, seeds, limits);
      }
    }
  } catch (e) {
    console.warn('Synthetic branching expansion skipped:', e);
  }

  const { edges, edgeHistogram, symbolEdgeCount, weightSum } = accumulator;


  // Prune to limits if configured
  try {
    const limits = resolveLimitsFromSettings(cfg);
    // 1) prune low-weight edges if over cap
    edges.sort((a,b) => (a.w ?? 0) - (b.w ?? 0));
    while (edges.length > limits.maxEdges) {
      if (!edges.length) break;
      const candidate = edges[0];
      if ((candidate.w ?? 0) > limits.pruneWeightThreshold) break;
      edges.shift();
    }
    // 2) drop isolated nodes if over cap
    const nodeSet = new Set(nodes.map(n => n.token));
    const connected = new Set<string>();
    for (const e of edges) {
      if (e.source) connected.add(e.source);
      if (e.target) connected.add(e.target);
    }
    if (nodes.length > limits.maxNodes) {
      const keep = nodes.filter(n => n?.token && connected.has(n.token));
      if (keep.length) {
        nodes.length = 0; nodes.push(...keep.slice(0, limits.maxNodes));
      } else {
        nodes.length = limits.maxNodes;
      }
    }
  } catch (e) {
    console.warn('Prune-to-limits skipped:', e);
  }

  const graph: PipelineGraph = { nodes, edges };
  const top = rankNodes(nodes, 20);

  const metrics = {
    tokenCount: tokens.length,
    wordCount,
    symbolCount,
    symbolDensity: tokens.length === 0 ? 0 : symbolCount / tokens.length,
    edgeCount: edges.length,
    symbolEdgeCount,
    weightSum,
  };

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

  return {
    tokens,
    graph,
    edges,
    metrics,
    top,
    consciousness,
  };
}
