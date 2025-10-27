import { SETTINGS, type Settings } from '../settings.js';
import { tokenizeWithSymbols, tokenizeWords, type Token, computeWordNeighborMap } from '../tokens/tokenize.js';
import { emitSymbolEdges } from '../graph/symbol_edges.js';
import { rankNodes } from '../analytics/metrics.js';
import { emitPipelineTelemetry } from '../analytics/telemetry.js';

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

export function runPipeline(input: string, cfg: Settings = SETTINGS): PipelineResult {
  const tokens = cfg.tokenizeSymbols ? tokenizeWithSymbols(input) : legacyTokenizeDetailed(input);
  const nodes = buildGraphNodes(tokens);
  const edges: PipelineGraph['edges'] = [];

  let symbolEdgeCount = 0;
  let weightSum = 0;
  const edgeHistogram: Record<string, number> = Object.create(null);

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

  const addEdge = (source: Token, target: Token, props: { type: string; w?: number; meta?: Record<string, unknown> }) => {
    const isSymbolEdge = source.kind === 'sym' || target.kind === 'sym';
    if (isSymbolEdge && symbolEdgeCount >= symbolEdgeLimit) return;

    const weight = typeof props.w === 'number' ? props.w : 0;
    const entry = {
      source: source.t,
      target: target.t,
      type: props.type,
      w: weight,
      meta: props.meta,
    };
    edges.push(entry);
    if (isSymbolEdge) symbolEdgeCount += 1;
    if (typeof weight === 'number' && Number.isFinite(weight)) {
      weightSum += weight;
    }
    if (entry.type) {
      edgeHistogram[entry.type] = (edgeHistogram[entry.type] || 0) + 1;
    }
  };

  if (cfg.tokenizeSymbols) {
    const neighborMap = computeWordNeighborMap(tokens);
    emitSymbolEdges(tokens, addEdge, cfg.symbolWeightScale, cfg.symbolEmitMode, neighborMap);
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
    });
  }

  return {
    tokens,
    graph,
    edges,
    metrics,
    top,
  };
}
