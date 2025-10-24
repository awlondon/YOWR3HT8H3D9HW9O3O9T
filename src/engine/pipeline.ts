import { SETTINGS, type Settings } from '../settings';
import { tokenizeWithSymbols, tokenizeWords, type Token } from '../tokens/tokenize';
import { emitSymbolEdges } from '../graph/symbol_edges';
import { rankNodes } from '../analytics/metrics';

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
  const limit = Math.max(0, Math.ceil(tokens.length / 5) * 2);

  const addEdge = (source: Token, target: Token, props: { type: string; w?: number; meta?: Record<string, unknown> }) => {
    const isSymbolEdge = source.kind === 'sym' || target.kind === 'sym';
    if (isSymbolEdge && symbolEdgeCount >= limit) return;

    const weight = typeof props.w === 'number' ? props.w : 0;
    edges.push({
      source: source.t,
      target: target.t,
      type: props.type,
      w: weight,
      meta: props.meta,
    });
    if (isSymbolEdge) symbolEdgeCount += 1;
  };

  if (cfg.tokenizeSymbols) {
    emitSymbolEdges(tokens, addEdge, cfg.symbolWeightScale, cfg.symbolEmitMode);
  }

  const symbolCount = tokens.filter(tok => tok.kind === 'sym').length;
  const wordCount = tokens.length - symbolCount;
  const weightSum = edges.reduce((sum, edge) => sum + (typeof edge.w === 'number' ? edge.w : 0), 0);
  const graph: PipelineGraph = { nodes, edges };
  const top = rankNodes(nodes, 20);

  return {
    tokens,
    graph,
    edges,
    metrics: {
      tokenCount: tokens.length,
      wordCount,
      symbolCount,
      symbolDensity: tokens.length === 0 ? 0 : symbolCount / tokens.length,
      edgeCount: edges.length,
      symbolEdgeCount,
      weightSum,
    },
    top,
  };
}
