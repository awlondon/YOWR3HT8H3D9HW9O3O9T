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

  const { edges, edgeHistogram, symbolEdgeCount, weightSum } = accumulator;
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
