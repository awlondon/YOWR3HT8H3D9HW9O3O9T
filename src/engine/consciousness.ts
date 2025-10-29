import { nodeScore } from '../analytics/metrics.js';
import type { Token } from '../tokens/tokenize.js';

export interface ConsciousnessEdge {
  source: string;
  target: string;
  type?: string;
  w?: number;
}

export interface ConsciousnessNode {
  token: string;
  kind?: string;
  cat?: string | null;
  rawScore?: number;
}

export interface ConsciousnessGraph {
  nodes: ConsciousnessNode[];
  edges: ConsciousnessEdge[];
}

export interface WorkspaceSignal {
  token: string;
  salience: number;
  iteration: number;
  sources: string[];
  kind?: string;
  cat?: string | null;
}

export interface RecurrentActivationTrace {
  iteration: number;
  activations: WorkspaceSignal[];
}

export interface CausalImpactEstimate {
  token: string;
  integrationDrop: number;
  relativeDrop: number;
}

export interface ConsciousnessMetaMetrics {
  integrationScore: number;
  differentiationScore: number;
  broadcastWidth: number;
  confidence: number;
  salienceEntropy: number;
  causalImpact: CausalImpactEstimate[];
  notes: string[];
}

export interface ConsciousnessWorkspace {
  iterations: number;
  broadcast: WorkspaceSignal[];
  accessList: string[];
}

export interface ConsciousnessState {
  workspace: ConsciousnessWorkspace;
  recurrentTrace: RecurrentActivationTrace[];
  meta: ConsciousnessMetaMetrics;
}

interface PropagatedActivation {
  value: number;
  sources: Set<string>;
  iteration: number;
}

interface AdjacencyEntry {
  target: string;
  weight: number;
  type?: string;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function normalizeSalienceMap(map: Map<string, PropagatedActivation>): WorkspaceSignal[] {
  const entries: WorkspaceSignal[] = [];
  for (const [token, data] of map.entries()) {
    entries.push({
      token,
      salience: data.value,
      iteration: data.iteration,
      sources: Array.from(data.sources).sort(),
    });
  }
  return entries
    .filter(entry => Number.isFinite(entry.salience) && entry.salience > 0)
    .sort((a, b) => b.salience - a.salience);
}

function attachNodeMetadata(signals: WorkspaceSignal[], nodes: ConsciousnessNode[]): WorkspaceSignal[] {
  const nodeMap = new Map<string, ConsciousnessNode>();
  for (const node of nodes) {
    if (!node || typeof node.token !== 'string') continue;
    nodeMap.set(node.token, node);
  }
  return signals.map(signal => {
    const node = nodeMap.get(signal.token);
    if (!node) return signal;
    return { ...signal, kind: node.kind, cat: node.cat };
  });
}

function buildAdjacencyMap(edges: ConsciousnessEdge[]): Map<string, AdjacencyEntry[]> {
  const adjacency = new Map<string, AdjacencyEntry[]>();

  const push = (source: string, target: string, weight: number, type?: string) => {
    if (!source || !target) return;
    if (!Number.isFinite(weight) || weight <= 0) return;
    const list = adjacency.get(source) || [];
    list.push({ target, weight, type });
    adjacency.set(source, list);
  };

  for (const edge of edges) {
    const weight = typeof edge.w === 'number' && Number.isFinite(edge.w)
      ? Math.abs(edge.w)
      : 1;
    const { source, target, type } = edge;
    push(source, target, weight, type);
    push(target, source, weight, type);
  }

  return adjacency;
}

function initialActivation(tokens: Token[], nodes: ConsciousnessNode[]): Map<string, PropagatedActivation> {
  const activations = new Map<string, PropagatedActivation>();
  const nodeMap = new Map<string, ConsciousnessNode>();
  for (const node of nodes) {
    if (!node || typeof node.token !== 'string') continue;
    nodeMap.set(node.token, node);
  }

  for (const token of tokens) {
    if (!token || typeof token.t !== 'string' || !token.t) continue;
    const node = nodeMap.get(token.t) || { token: token.t, kind: token.kind, rawScore: token.n };
    const base = clamp(nodeScore({ kind: node.kind, rawScore: node.rawScore }), 0, Number.POSITIVE_INFINITY);
    activations.set(token.t, {
      value: base,
      sources: new Set([token.t]),
      iteration: 0,
    });
  }

  return activations;
}

function propagateOnce(
  current: Map<string, PropagatedActivation>,
  adjacency: Map<string, AdjacencyEntry[]>,
  dampening: number,
  iteration: number,
): Map<string, PropagatedActivation> {
  const next = new Map<string, PropagatedActivation>();

  const ensureEntry = (token: string) => {
    let entry = next.get(token);
    if (!entry) {
      entry = { value: 0, sources: new Set<string>(), iteration };
      next.set(token, entry);
    }
    return entry;
  };

  for (const [token, activation] of current.entries()) {
    const neighbors = adjacency.get(token) || [];
    const totalWeight = neighbors.reduce((sum, item) => sum + item.weight, 0);
    const selfEntry = ensureEntry(token);
    selfEntry.value += activation.value * (1 - dampening);
    for (const source of activation.sources) {
      selfEntry.sources.add(source);
    }
    selfEntry.iteration = Math.max(selfEntry.iteration, iteration);

    if (totalWeight <= 0) continue;

    for (const neighbor of neighbors) {
      const share = (activation.value * dampening * neighbor.weight) / totalWeight;
      if (!Number.isFinite(share) || share <= 0) continue;
      const entry = ensureEntry(neighbor.target);
      entry.value += share;
      for (const source of activation.sources) {
        entry.sources.add(source);
      }
      entry.sources.add(token);
      entry.iteration = Math.max(entry.iteration, iteration);
    }
  }

  return next;
}

function computeBroadcast(
  activations: Map<string, PropagatedActivation>,
  nodes: ConsciousnessNode[],
  limit: number,
): WorkspaceSignal[] {
  const normalized = attachNodeMetadata(normalizeSalienceMap(activations), nodes);
  return normalized.slice(0, limit);
}

function computeEntropy(signals: WorkspaceSignal[]): number {
  if (!signals.length) return 0;
  const total = signals.reduce((sum, signal) => sum + signal.salience, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const signal of signals) {
    const p = signal.salience / total;
    if (p <= 0) continue;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function computeIntegrationScore(
  focus: Set<string>,
  adjacency: Map<string, AdjacencyEntry[]>,
): number {
  if (!focus.size) return 0;
  let connectionWeight = 0;
  let possibleConnections = 0;
  for (const token of focus) {
    const neighbors = adjacency.get(token) || [];
    for (const neighbor of neighbors) {
      if (focus.has(neighbor.target)) {
        connectionWeight += neighbor.weight;
      }
      possibleConnections += neighbor.weight;
    }
  }
  if (possibleConnections <= 0) return 0;
  return clamp(connectionWeight / possibleConnections, 0, 1);
}

function computeDifferentiationScore(signals: WorkspaceSignal[]): number {
  if (!signals.length) return 0;
  const categories = new Set<string>();
  for (const signal of signals) {
    if (signal.cat) {
      categories.add(signal.cat);
    } else if (signal.kind) {
      categories.add(signal.kind);
    }
  }
  return clamp(categories.size / signals.length, 0, 1);
}

function estimateCausalImpact(
  broadcast: WorkspaceSignal[],
  adjacency: Map<string, AdjacencyEntry[]>,
): CausalImpactEstimate[] {
  if (!broadcast.length) return [];
  const focus = new Set(broadcast.map(item => item.token));
  const baseline = computeIntegrationScore(focus, adjacency);
  if (baseline === 0) {
    return broadcast.slice(0, 5).map(item => ({ token: item.token, integrationDrop: 0, relativeDrop: 0 }));
  }
  return broadcast.slice(0, 5).map(item => {
    const reduced = new Set(focus);
    reduced.delete(item.token);
    const reducedScore = computeIntegrationScore(reduced, adjacency);
    const drop = clamp(baseline - reducedScore, 0, 1);
    const relative = clamp(drop / baseline, 0, 1);
    return { token: item.token, integrationDrop: drop, relativeDrop: relative };
  });
}

export function buildConsciousnessState(
  tokens: Token[],
  graph: ConsciousnessGraph,
  iterations = 3,
): ConsciousnessState {
  const adjacency = buildAdjacencyMap(graph.edges || []);
  let current = initialActivation(tokens, graph.nodes || []);
  const trace: RecurrentActivationTrace[] = [];
  const maxIterations = Math.max(1, iterations);
  const dampening = 0.6;

  for (let i = 1; i <= maxIterations; i += 1) {
    current = propagateOnce(current, adjacency, dampening, i);
    const snapshot = computeBroadcast(current, graph.nodes || [], 8);
    trace.push({ iteration: i, activations: snapshot });
  }

  const broadcast = computeBroadcast(current, graph.nodes || [], 10);
  const accessList = broadcast.map(entry => entry.token);
  const integrationScore = computeIntegrationScore(new Set(accessList), adjacency);
  const differentiationScore = computeDifferentiationScore(broadcast);
  const broadcastWidth = broadcast.length;
  const salienceEntropy = computeEntropy(broadcast);
  const confidence = clamp(
    0.55 * integrationScore + 0.35 * differentiationScore + 0.1 * clamp(broadcastWidth / 10, 0, 1),
    0,
    1,
  );
  const causalImpact = estimateCausalImpact(broadcast, adjacency);

  const notes: string[] = [];
  if (broadcastWidth) {
    notes.push(
      `Global workspace broadcasting ${broadcastWidth} tokens with integration ${(integrationScore * 100).toFixed(1)}%.`,
    );
  }
  if (trace.length) {
    const lastIteration = trace[trace.length - 1];
    notes.push(
      `Recurrent loop stabilized after ${trace.length} iterations; latest focus: ${lastIteration.activations
        .slice(0, 3)
        .map(item => item.token)
        .join(', ')}.`,
    );
  }
  notes.push(
    `Meta-monitoring gauges differentiation ${(differentiationScore * 100).toFixed(1)}% and salience entropy ${salienceEntropy.toFixed(2)} bits.`,
  );

  return {
    workspace: {
      iterations: trace.length,
      broadcast,
      accessList,
    },
    recurrentTrace: trace,
    meta: {
      integrationScore,
      differentiationScore,
      broadcastWidth,
      confidence,
      salienceEntropy,
      causalImpact,
      notes,
    },
  };
}
