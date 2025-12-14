import { collapseGraph, computeTokenSalience } from './salience.js';
import type { ConvergenceThrottleConfig } from './expansionModes.js';

type GraphNode = { id: string; label?: string; meta?: Record<string, any>; appearanceFrequency?: number; frequency?: number; weight?: number; position?: [number, number]; x?: number; y?: number };
type GraphEdge = { src?: string; dst?: string; source?: string; target?: string; weight?: number; w?: number };

export interface ThrottleState {
  lastThrottleAt: number;
  throttles: number;
  cycles: number;
}

export interface ThrottleDecision {
  shouldThrottle: boolean;
  reason?: string;
  hubId?: string;
  hubLabel?: string;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'latent',
  'axis',
  'vector',
  'embedding',
]);

function getNodeId(node: GraphNode): string | null {
  return node?.id ?? null;
}

function getEdgeWeight(edge: GraphEdge): number {
  const weight = edge.weight ?? edge.w;
  return Number.isFinite(weight) ? Number(weight) : 1;
}

function isStopToken(label: string | undefined): boolean {
  if (!label) return false;
  return STOPWORDS.has(label.toLowerCase());
}

function normalizeGraph(graph: { nodes: Map<string, GraphNode> | GraphNode[]; edges: GraphEdge[] }) {
  const nodes = graph.nodes instanceof Map ? Array.from(graph.nodes.values()) : graph.nodes;
  const nodeMap = graph.nodes instanceof Map ? graph.nodes : new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  return { nodes, nodeMap, edges };
}

export function updateCycles(state: ThrottleState): void {
  state.cycles += 1;
}

export function selectHubForConvergence(graph: { nodes: Map<string, GraphNode> | GraphNode[]; edges: GraphEdge[] }): {
  hubId: string;
  hubLabel: string;
} {
  const { nodes, nodeMap, edges } = normalizeGraph(graph);
  const salience = computeTokenSalience(graph as any);
  let bestId: string | null = null;
  let bestScore = -Infinity;

  salience.forEach((score, id) => {
    const node = nodeMap.get(id);
    if (!node || isStopToken(node.label)) return;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  });

  if (!bestId) {
    const fallbackScores = new Map<string, number>();
    edges.forEach((edge) => {
      const src = edge.src ?? edge.source;
      const dst = edge.dst ?? edge.target;
      if (!src || !dst) return;
      const weight = getEdgeWeight(edge);
      fallbackScores.set(src, (fallbackScores.get(src) ?? 0) + weight);
      fallbackScores.set(dst, (fallbackScores.get(dst) ?? 0) + weight);
    });

    nodes.forEach((node) => {
      const id = getNodeId(node);
      if (!id || isStopToken(node.label)) return;
      const base = fallbackScores.get(id) ?? 0;
      const freq = Number(node.appearanceFrequency ?? node.frequency ?? 0);
      const weighted = base + (Number.isFinite(freq) ? freq : 0);
      fallbackScores.set(id, weighted);
    });

    fallbackScores.forEach((score, id) => {
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    });

    if (!bestId && nodes.length) {
      const degree = new Map<string, number>();
      edges.forEach((edge) => {
        const src = edge.src ?? edge.source;
        const dst = edge.dst ?? edge.target;
        if (src) degree.set(src, (degree.get(src) ?? 0) + 1);
        if (dst) degree.set(dst, (degree.get(dst) ?? 0) + 1);
      });
      const ranked = nodes
        .filter((node) => !isStopToken(node.label))
        .sort((a, b) => (degree.get(getNodeId(b) || '') ?? 0) - (degree.get(getNodeId(a) || '') ?? 0));
      const candidate = ranked[0];
      if (candidate?.id) {
        bestId = candidate.id;
      }
    }
  }

  const hubId = bestId || (nodes[0]?.id ?? 'hub');
  const hubLabel = nodeMap.get(hubId)?.label ?? hubId;
  return { hubId, hubLabel };
}

export function shouldThrottleField(
  graph: { nodes: Map<string, GraphNode> | GraphNode[]; edges: GraphEdge[] },
  cfg: ConvergenceThrottleConfig,
  state: ThrottleState,
  now: number,
): ThrottleDecision {
  if (!cfg.enabled) return { shouldThrottle: false, reason: 'disabled' };
  const nodeCount = graph.nodes instanceof Map ? graph.nodes.size : graph.nodes.length;
  const edgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0;

  const hysteresisNodeLimit = Math.floor(cfg.maxFieldNodes * (1 - cfg.hysteresis));
  const hysteresisEdgeLimit = Math.floor(cfg.maxFieldEdges * (1 - cfg.hysteresis));

  if (state.throttles > 0 && (nodeCount > hysteresisNodeLimit || edgeCount > hysteresisEdgeLimit)) {
    return { shouldThrottle: false, reason: 'hysteresis' };
  }

  if (state.cycles < cfg.minCyclesBeforeThrottle) return { shouldThrottle: false, reason: 'min-cycles' };
  if (now - state.lastThrottleAt < cfg.cooldownMs) return { shouldThrottle: false, reason: 'cooldown' };

  if (nodeCount >= cfg.maxFieldNodes || edgeCount >= cfg.maxFieldEdges) {
    const { hubId, hubLabel } = selectHubForConvergence(graph);
    return { shouldThrottle: true, hubId, hubLabel };
  }

  return { shouldThrottle: false };
}

export function collapseToPoint(
  graph: { nodes: Map<string, GraphNode> | GraphNode[]; edges: GraphEdge[] },
  hubId: string,
  cfg: ConvergenceThrottleConfig,
): { collapsedGraph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] }; keptTokenIds: Set<string> } {
  const collapsed = collapseGraph(graph as any, [hubId], cfg.collapseRadius) as { nodes: Map<string, GraphNode>; edges: GraphEdge[] };
  const hub = collapsed.nodes.get(hubId);
  const keptTokenIds = new Set<string>(collapsed.nodes.keys());
  if (hub) {
    hub.position = [0, 0];
    hub.x = 0;
    hub.y = 0;
  }

  const jitter = () => (Math.random() - 0.5) * 0.01;
  collapsed.nodes.forEach((node, id) => {
    if (id === hubId) return;
    node.position = [jitter(), jitter()];
    node.x = node.position[0];
    node.y = node.position[1];
  });

  return { collapsedGraph: collapsed, keptTokenIds };
}

export async function reseedFieldFromHub(
  hubId: string,
  graph: { nodes: Map<string, GraphNode> | GraphNode[]; edges: GraphEdge[] },
  cfg: ConvergenceThrottleConfig,
  deps: {
    getAdjacencyDelta: (token: string) => Promise<{ nodes?: any[]; edges?: any[] }>;
    applyAdjacencyDelta: (graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] }, delta: any, layer: string) => void;
    shouldAbort?: () => boolean;
    log?: (msg: string) => void;
  },
): Promise<{ nodes: Map<string, GraphNode>; edges: GraphEdge[] }> {
  const baseNodes = graph.nodes instanceof Map ? graph.nodes : new Map(graph.nodes.map((n) => [n.id, n]));
  const hubLabel = baseNodes.get(hubId)?.label ?? hubId;

  const newGraph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] } = { nodes: new Map(), edges: [] };
  newGraph.nodes.set(hubId, { ...(baseNodes.get(hubId) ?? { id: hubId, label: hubLabel }), id: hubId, label: hubLabel, meta: { layer: 'visible' } });

  const adjacency = await deps.getAdjacencyDelta(hubLabel);
  deps.applyAdjacencyDelta(newGraph, adjacency, 'visible');
  if (deps.shouldAbort?.()) return graph as any;

  const neighbors: Array<{ id: string; label: string }> = [];
  const neighborEdges = Array.isArray(adjacency.edges) ? adjacency.edges : [];
  neighborEdges
    .sort((a, b) => getEdgeWeight(b) - getEdgeWeight(a))
    .forEach((edge) => {
      const target = edge.src === hubId || edge.source === hubId ? edge.dst ?? edge.target : edge.src ?? edge.source;
      if (!target) return;
      const node = newGraph.nodes.get(target);
      if (node) neighbors.push({ id: target, label: node.label ?? target });
    });

  const ring = neighbors.slice(0, cfg.reseedRingSize);

  for (const ringNode of ring) {
    if (deps.shouldAbort?.()) return graph as any;
    const delta = await deps.getAdjacencyDelta(ringNode.label);
    deps.applyAdjacencyDelta(newGraph, delta, 'hidden');

    const ringEdges = Array.isArray(delta.edges) ? delta.edges : [];
    const branchTargets: Array<{ id: string; label: string }> = [];
    ringEdges
      .sort((a, b) => getEdgeWeight(b) - getEdgeWeight(a))
      .forEach((edge) => {
        const target = edge.src === ringNode.id || edge.source === ringNode.id ? edge.dst ?? edge.target : edge.src ?? edge.source;
        if (!target) return;
        const node = newGraph.nodes.get(target);
        if (node) branchTargets.push({ id: target, label: node.label ?? target });
      });

    for (const branch of branchTargets.slice(0, cfg.reseedBranches)) {
      if (deps.shouldAbort?.()) return graph as any;
      deps.log?.(`[throttle] reseed branch ${branch.label}`);
      const branchDelta = await deps.getAdjacencyDelta(branch.label);
      deps.applyAdjacencyDelta(newGraph, branchDelta, 'hidden');
    }
  }

  return newGraph;
}
