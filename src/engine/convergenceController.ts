import { computeTokenSalience, collapseGraph } from './salience.js';
import type { HLSFGraph } from './cognitionCycle.js';
import type { AdjacencyResult } from './adjacencyProvider.js';

interface GraphNode {
  id: string;
  label: string;
  meta?: Record<string, unknown>;
}

interface GraphEdge {
  src: string;
  dst: string;
  weight?: number;
  role?: string;
}

interface WorkingGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  metadata?: Record<string, unknown>;
}

export interface ConvergenceResult {
  hubId: string;
  hubLabel: string;
  collapsedGraph: HLSFGraph;
  level1Graph: HLSFGraph;
  thoughtTraces: string[];
}

interface ConvergenceDeps {
  getAdjacency: (token: string) => Promise<AdjacencyResult>;
  applyAdjacencyToGraph?: (graph: WorkingGraph, adjacency: AdjacencyResult) => void;
  computeSalience?: (graph: WorkingGraph) => Map<string, number>;
  collapseGraph?: (graph: WorkingGraph, centers: string[], radius: number) => WorkingGraph;
  commitGraph: (graph: HLSFGraph) => void;
  emitThought: (text: string) => void;
  shouldAbort: () => boolean;
  normalizeToken: (text: string) => string;
}

interface ConvergenceCfg {
  salienceTopK?: number;
  expandDepthMax?: number;
  convergeMinDepth?: number;
  convergeStability?: number;
  collapseRadius?: number;
  level1RingSize?: number;
  level1Branches?: number;
  recurseBudgetNodes?: number;
  recurseBudgetEdges?: number;
  recurseStepsMax?: number;
  stopwordsEnabled?: boolean;
}

const DEFAULT_CFG: Required<ConvergenceCfg> = {
  salienceTopK: 4,
  expandDepthMax: 6,
  convergeMinDepth: 2,
  convergeStability: 2,
  collapseRadius: 2,
  level1RingSize: 9,
  level1Branches: 5,
  recurseBudgetNodes: 250,
  recurseBudgetEdges: 1200,
  recurseStepsMax: 6,
  stopwordsEnabled: true,
};

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'i', 'my', 'me', 'it', 'you']);

function normalizeGraph(graph?: WorkingGraph): WorkingGraph {
  return graph ?? { nodes: new Map(), edges: [], metadata: {} };
}

function ensureNode(graph: WorkingGraph, id: string, label: string): void {
  if (!graph.nodes.has(id)) {
    graph.nodes.set(id, { id, label });
  }
}

function applyAdjacency(graph: WorkingGraph, adjacency: AdjacencyResult, deps: ConvergenceDeps): void {
  if (deps.applyAdjacencyToGraph) {
    deps.applyAdjacencyToGraph(graph, adjacency);
    return;
  }
  const sourceId = deps.normalizeToken(adjacency.token) || adjacency.token;
  ensureNode(graph, sourceId, adjacency.token);
  adjacency.neighbors.forEach((neighbor) => {
    const normalized = deps.normalizeToken(neighbor.token) || neighbor.token;
    ensureNode(graph, normalized, neighbor.token);
    graph.edges.push({ src: sourceId, dst: normalized, weight: neighbor.weight, role: neighbor.rel });
  });
}

function graphToHlsfGraph(graph: WorkingGraph): HLSFGraph {
  return {
    nodes: Array.from(graph.nodes.values()).map((node) => ({
      id: node.id,
      label: node.label,
      layer: 0,
      cluster: 0,
      weight: 1,
    })) as any,
    edges: graph.edges.map((edge, index) => ({
      id: edge.src + edge.dst + index,
      source: edge.src,
      target: edge.dst,
      weight: edge.weight ?? 0,
    })) as any,
    metadata: graph.metadata ?? {},
  };
}

function pickSeedFromPrompt(prompt: string, normalize: (text: string) => string): string {
  const tokens = prompt
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9'-]/gi, ''))
    .filter(Boolean);
  const proper = tokens.find((t) => /^[A-Z]/.test(t));
  if (proper) return normalize(proper);
  const filtered = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const longest = filtered.sort((a, b) => b.length - a.length)[0];
  return normalize(longest || tokens[0] || 'seed');
}

function chooseHub(graph: WorkingGraph, cfg: Required<ConvergenceCfg>, deps: ConvergenceDeps, lastHub?: string) {
  const salience = deps.computeSalience ? deps.computeSalience(graph) : computeTokenSalience(graph as any);
  const entries = Array.from(salience.entries())
    .filter(([id]) => !cfg.stopwordsEnabled || !STOPWORDS.has(graph.nodes.get(id)?.label.toLowerCase?.() || ''))
    .sort((a, b) => b[1] - a[1]);
  const top = entries[0]?.[0] || lastHub || graph.nodes.keys().next().value;
  return { hubId: top, salience };
}

function ensureCollapseMinimum(
  graph: WorkingGraph,
  hubId: string,
  collapsed: WorkingGraph,
  ringSize: number,
): WorkingGraph {
  if (collapsed.nodes.size >= Math.min(graph.nodes.size, ringSize + 1) || graph.edges.length === 0) {
    return collapsed;
  }
  const neighbors = graph.edges
    .filter((edge) => edge.src === hubId || edge.dst === hubId)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, ringSize)
    .map((edge) => (edge.src === hubId ? edge.dst : edge.src));
  neighbors.forEach((neighbor) => {
    const node = graph.nodes.get(neighbor);
    if (node) collapsed.nodes.set(neighbor, node);
  });
  collapsed.edges = graph.edges.filter((edge) => collapsed.nodes.has(edge.src) && collapsed.nodes.has(edge.dst));
  return collapsed.nodes.size > 1 ? collapsed : graph;
}

function describeRing(graph: WorkingGraph, hubId: string, ringSize: number): string[] {
  return graph.edges
    .filter((edge) => edge.src === hubId || edge.dst === hubId)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .map((edge) => (edge.src === hubId ? edge.dst : edge.src))
    .filter(Boolean)
    .slice(0, ringSize);
}

export async function buildLevel1GraphFromHub(
  hubToken: string,
  cfg: Required<ConvergenceCfg>,
  deps: ConvergenceDeps,
): Promise<{ graph: WorkingGraph; ring: string[]; cc: string[] }> {
  const graph: WorkingGraph = { nodes: new Map(), edges: [] };
  const hubId = deps.normalizeToken(hubToken) || hubToken;
  ensureNode(graph, hubId, hubToken);

  const hubAdjacency = await deps.getAdjacency(hubToken);
  applyAdjacency(graph, hubAdjacency, deps);
  const ring = describeRing(graph, hubId, cfg.level1RingSize);

  const cc: string[] = [];
  for (const ringId of ring) {
    if (deps.shouldAbort()) break;
    const ringNode = graph.nodes.get(ringId);
    if (!ringNode) continue;
    const adjacency = await deps.getAdjacency(ringNode.label);
    const sorted = [...adjacency.neighbors].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    sorted.slice(0, cfg.level1Branches).forEach((neighbor) => {
      const childId = deps.normalizeToken(neighbor.token) || neighbor.token;
      ensureNode(graph, childId, neighbor.token);
      graph.edges.push({ src: ringId, dst: childId, weight: neighbor.weight, role: neighbor.rel });
      cc.push(childId);
    });
  }

  deps.commitGraph(graphToHlsfGraph(graph));
  return { graph, ring, cc };
}

function pickNextStep(
  graph: WorkingGraph,
  current: string,
  salience: Map<string, number>,
): { nextId: string; via?: GraphEdge } | null {
  const outgoing = graph.edges.filter((edge) => edge.src === current || edge.dst === current);
  if (outgoing.length) {
    const edge = outgoing.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
    return { nextId: edge.src === current ? edge.dst : edge.src, via: edge };
  }
  const sorted = Array.from(salience.entries()).sort((a, b) => b[1] - a[1]);
  const candidate = sorted.find(([id]) => id !== current);
  if (candidate) return { nextId: candidate[0] };
  return null;
}

async function runRecursion(
  graph: WorkingGraph,
  hubId: string,
  cfg: Required<ConvergenceCfg>,
  deps: ConvergenceDeps,
  thoughtTraces: string[],
): Promise<void> {
  let current = hubId;
  let nodesBudget = cfg.recurseBudgetNodes;
  let edgesBudget = cfg.recurseBudgetEdges;
  const salience = deps.computeSalience ? deps.computeSalience(graph) : computeTokenSalience(graph as any);

  for (let step = 1; step <= cfg.recurseStepsMax; step += 1) {
    if (deps.shouldAbort()) break;
    const choice = pickNextStep(graph, current, salience);
    if (!choice) break;
    const via = choice.via;
    const viaRel = via?.role || 'rel';
    const viaWeight = via?.weight ?? 0;
    thoughtTraces.push(`Step ${step}: ${graph.nodes.get(current)?.label || current} → ${graph.nodes.get(choice.nextId)?.label || choice.nextId} via ${viaRel} (w=${viaWeight.toFixed(2)})`);
    deps.emitThought(thoughtTraces[thoughtTraces.length - 1]);

    current = choice.nextId;
    nodesBudget -= 1;
    edgesBudget -= via ? 1 : 0;
    if (nodesBudget <= 0 || edgesBudget <= 0) break;
  }
}

export async function runConvergencePipeline(
  input: { prompt?: string; seedToken?: string },
  cfgInput: ConvergenceCfg,
  deps: ConvergenceDeps,
): Promise<ConvergenceResult> {
  const cfg: Required<ConvergenceCfg> = { ...DEFAULT_CFG, ...cfgInput };
  const graph: WorkingGraph = normalizeGraph();
  const thoughtTraces: string[] = [];

  const seedLabel = input.seedToken?.trim() || (input.prompt ? pickSeedFromPrompt(input.prompt, deps.normalizeToken) : 'seed');
  const seedId = deps.normalizeToken(seedLabel) || seedLabel;
  ensureNode(graph, seedId, seedLabel);

  let frontier = new Set<string>([seedId]);
  let lastHub: string | null = null;
  let stability = 0;

  for (let depth = 1; depth <= cfg.expandDepthMax; depth += 1) {
    if (deps.shouldAbort()) break;
    const nextFrontier = new Set<string>();
    for (const nodeId of frontier) {
      if (deps.shouldAbort()) break;
      const node = graph.nodes.get(nodeId);
      if (!node) continue;
      const adjacency = await deps.getAdjacency(node.label);
      applyAdjacency(graph, adjacency, deps);
      adjacency.neighbors
        .slice(0, cfg.level1RingSize)
        .forEach((neighbor) => nextFrontier.add(deps.normalizeToken(neighbor.token) || neighbor.token));
    }

    deps.commitGraph(graphToHlsfGraph(graph));

    const { hubId, salience } = chooseHub(graph, cfg, deps, lastHub || undefined);
    stability = hubId === lastHub ? stability + 1 : 1;
    lastHub = hubId;

    const topTokens = Array.from(salience.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => graph.nodes.get(id)?.label || id)
      .join(', ');
    deps.emitThought(`Depth ${depth}: hub≈${graph.nodes.get(hubId)?.label || hubId} | top tokens: ${topTokens}`);

    if (depth >= cfg.convergeMinDepth && stability >= cfg.convergeStability) {
      break;
    }

    frontier = nextFrontier.size ? nextFrontier : frontier;
  }

  const hubId = lastHub || seedId;
  const hubLabel = graph.nodes.get(hubId)?.label || hubId;

  const collapsed = ensureCollapseMinimum(
    graph,
    hubId,
    deps.collapseGraph ? deps.collapseGraph(graph, [hubId], cfg.collapseRadius) : (collapseGraph(graph as any, [hubId], cfg.collapseRadius) as WorkingGraph),
    cfg.level1RingSize,
  );
  deps.commitGraph(graphToHlsfGraph(collapsed));
  deps.emitThought(
    `CONVERGED: hub=${hubLabel} | collapsed radius=${cfg.collapseRadius} | nodes=${collapsed.nodes.size} edges=${collapsed.edges.length}`,
  );

  const { graph: level1Graph, ring, cc } = await buildLevel1GraphFromHub(hubLabel, cfg, deps);
  deps.emitThought(
    `LEVEL-1 FIELD: hub=${hubLabel} ring=${ring.map((id) => level1Graph.nodes.get(id)?.label || id).join(',')} cc=${cc
      .map((id) => level1Graph.nodes.get(id)?.label || id)
      .slice(0, cfg.level1Branches)
      .join(',')}`,
  );

  await runRecursion(level1Graph, deps.normalizeToken(hubLabel) || hubLabel, cfg, deps, thoughtTraces);

  return {
    hubId,
    hubLabel,
    collapsedGraph: graphToHlsfGraph(collapsed),
    level1Graph: graphToHlsfGraph(level1Graph),
    thoughtTraces,
  };
}
