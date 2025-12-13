import { collapseGraph, computeTokenSalience } from './salience';

export type BreathingMode = 'prompt' | 'seed';

export interface GraphNode {
  id: string;
  label: string;
  weight?: number;
  layer?: string;
  appearanceFrequency?: number;
}

export interface GraphEdge {
  src: string;
  dst: string;
  weight: number;
  layer?: string;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export interface AdjacencyDelta {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BreathingConfig {
  dimension: number;
  depth: number;
  o10Size: number;
  ccBranches: number;
  collapseRadius: number;
  maxNodes: number;
  maxEdges: number;
  concurrency: number;
  breathLimit: number;
  rotationMillis: number;
  stopwords: Set<string>;
}

interface BreathingDeps {
  llm: {
    expandAdjacency(token: string): Promise<AdjacencyDelta>;
    articulate(thoughts: string[], collapsedGraph: Graph, promptOrSeed: string): Promise<string>;
  };
  applyDelta(delta: AdjacencyDelta, layer: string): void;
  getGraph(): Graph;
  setGraph(graph: Graph): void;
  onThought(thoughtEvent: string): void;
  onGraph(graph: Graph): void;
  shouldAbort(): boolean;
  cache: { get(key: string): AdjacencyDelta | undefined; set(key: string, value: AdjacencyDelta): void };
}

function limitGraph(graph: Graph, maxNodes: number, maxEdges: number): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const [id, node] of graph.nodes.entries()) {
    if (nodes.size >= maxNodes) break;
    nodes.set(id, node);
  }
  for (const edge of graph.edges) {
    if (edges.length >= maxEdges) break;
    if (nodes.has(edge.src) && nodes.has(edge.dst)) {
      edges.push(edge);
    }
  }
  return { nodes, edges };
}

async function expandRing(
  token: string,
  cfg: BreathingConfig,
  deps: BreathingDeps,
  size: number,
): Promise<string[]> {
  const delta = await deps.llm.expandAdjacency(token);
  deps.applyDelta(delta, 'o10');
  const sorted = [...delta.nodes].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const ring = sorted.slice(0, size).map((node) => node.id);
  return ring;
}

async function expandChildren(
  parents: string[],
  cfg: BreathingConfig,
  deps: BreathingDeps,
  branches: number,
): Promise<void> {
  for (const parent of parents) {
    if (deps.shouldAbort()) return;
    const delta = await deps.llm.expandAdjacency(parent);
    const sorted = [...delta.nodes].sort((a, b) => (b.weight || 0) - (a.weight || 0));
    const trimmed = { ...delta, nodes: sorted.slice(0, branches) };
    deps.applyDelta(trimmed, 'cc');
  }
}

function selectHub(graph: Graph, cfg: BreathingConfig, previousHub: string): string {
  const salience = computeTokenSalience({ nodes: graph.nodes, edges: graph.edges });
  let hub = previousHub;
  let bestScore = -Infinity;
  for (const [token, score] of salience.entries()) {
    if (cfg.stopwords.has(token.toLowerCase())) continue;
    if (score > bestScore) {
      bestScore = score;
      hub = token;
    }
  }
  return hub;
}

function summarizeThought(hub: string, graph: Graph): string {
  const edges = graph.edges.filter((edge) => edge.src === hub || edge.dst === hub);
  const neighbors = edges.map((edge) => (edge.src === hub ? edge.dst : edge.src));
  const uniq = Array.from(new Set(neighbors)).slice(0, 5);
  return `${hub}: ${uniq.join(', ')}`;
}

export async function runBreathingHlsf(
  input: string,
  cfg: BreathingConfig,
  deps: BreathingDeps,
): Promise<{ finalGraph: Graph; thoughts: string[]; finalText: string }> {
  let hub = input;
  let stableHub = 0;
  const thoughts: string[] = [];

  for (let breath = 0; breath < cfg.breathLimit; breath += 1) {
    if (deps.shouldAbort()) break;

    const ring = await expandRing(hub, cfg, deps, cfg.o10Size);
    await expandChildren(ring, cfg, deps, cfg.ccBranches);
    let graph = limitGraph(deps.getGraph(), cfg.maxNodes, cfg.maxEdges);
    deps.setGraph(graph);
    deps.onGraph(graph);

    await new Promise((resolve) => setTimeout(resolve, cfg.rotationMillis));
    if (deps.shouldAbort()) break;

    hub = selectHub(graph, cfg, hub);
    if (hub === input) stableHub += 1;
    const collapsed = collapseGraph(graph, [hub], cfg.collapseRadius);
    graph = collapsed;
    deps.setGraph(graph);
    deps.onGraph(graph);

    const summary = summarizeThought(hub, graph);
    deps.onThought(summary);
    thoughts.push(summary);

    if (stableHub >= 2 && breath >= 2) {
      break;
    }
  }

  const finalGraph = deps.getGraph();
  const finalText = await deps.llm.articulate(thoughts, finalGraph, input);
  return { finalGraph, thoughts, finalText };
}
