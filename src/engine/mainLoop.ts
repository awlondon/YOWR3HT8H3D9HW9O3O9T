/**
 * Integration loop for ThoughtEvents and articulation pipeline.
 * This file wires together detectors, accumulators, and LLM stubs.
 */

import {
  type Node,
  type Edge,
  type SpectralFeatures,
  type ResponseAccumulator,
  type Cluster,
  type AdjacencyDelta,
  type ThoughtEvent,
} from './cognitionTypes.js';
import { ThoughtDetector, type ClusterFeaturesInput } from './thoughtDetector.js';
import { ResponseAccumulatorEngine } from './responseAccumulator.js';
import { StubLLMClient } from './llmClient.js';
import { averageEmbedding, cosine } from './vectorUtils.js';

type EngineNodeMap = Map<string, Node>;

type EngineSpectralMap = Map<string, SpectralFeatures>;

type ThoughtEventHandler = (thoughtEvent: ThoughtEvent) => void;
type AdjacencyDeltaHandler = (delta: AdjacencyDelta) => void;
type ArticulationHandler = (responseText: string) => void;

interface EngineState {
  nodes: EngineNodeMap;
  edges: Edge[];
  spectralFeatures: EngineSpectralMap;
  thoughtDetector: ThoughtDetector;
  respEngine: ResponseAccumulatorEngine;
  llm: StubLLMClient;
  responseAccumulator: ResponseAccumulator | null;
  currentUserQuestion: string | null;
  currentUserEmbedding: number[] | null;
}

// Initialize engine state somewhere in setup code
const engineState: EngineState = {
  nodes: new Map(),
  edges: [],
  spectralFeatures: new Map(),
  thoughtDetector: new ThoughtDetector(),
  respEngine: new ResponseAccumulatorEngine(),
  llm: new StubLLMClient(),
  responseAccumulator: null,
  currentUserQuestion: null,
  currentUserEmbedding: null,
};

export function registerThoughtEventHandler(handler: ThoughtEventHandler): void {
  thoughtEventHandler = handler;
}

export function registerAdjacencyDeltaHandler(handler: AdjacencyDeltaHandler): void {
  adjacencyDeltaHandler = handler;
}

export function registerArticulationHandler(handler: ArticulationHandler): void {
  articulationHandler = handler;
}

export function updateEngineGraph(
  graphNodes: Node[],
  graphEdges: Edge[],
  spectral: Map<string, SpectralFeatures>,
): void {
  engineState.nodes = new Map(graphNodes.map(node => [node.id, node]));
  engineState.edges = graphEdges.slice();
  engineState.spectralFeatures = spectral;
}

const clusterPersistence = new Map<string, number>();
let thoughtEventHandler: ThoughtEventHandler | null = null;
let adjacencyDeltaHandler: AdjacencyDeltaHandler | null = null;
let articulationHandler: ArticulationHandler | null = null;

/**
 * Call when a new user question comes in.
 * queryEmbedding should be computed from existing embedding pipeline.
 */
export function onNewUserQuestion(question: string, queryEmbedding: number[], now: number) {
  engineState.currentUserQuestion = question;
  engineState.currentUserEmbedding = queryEmbedding;
  engineState.responseAccumulator = engineState.respEngine.initAccumulator(queryEmbedding, now);
}

/**
 * Main per-frame (or per-tick) update.
 * - Update layouts, spectral features externally as you already do.
 * - Then call this to run thought detection and articulation logic.
 */
export async function engineTick(now: number) {
  if (
    !engineState.currentUserEmbedding ||
    !engineState.currentUserQuestion ||
    !engineState.responseAccumulator
  ) {
    return;
  }

  const nodes = engineState.nodes;
  const spectralFeatures = engineState.spectralFeatures;
  const nodeEmbeddings = new Map<string, number[]>();
  nodes.forEach((n, id) => nodeEmbeddings.set(id, n.embedding));

  // 1) Build clusters from your existing clustering logic
  const clusters: Cluster[] = computeClustersFromLayoutAndAdjacency(
    nodes,
    engineState.edges,
    spectralFeatures,
  );

  // 2) For each cluster, compute structural / spectral / semantic scores
  for (const cluster of clusters) {
    const structuralScore = computeStructuralScore(cluster, engineState.edges);
    const spectralScore = computeSpectralScore(cluster, spectralFeatures);
    const semanticScore = computeSemanticScore(cluster, nodeEmbeddings);

    const input: ClusterFeaturesInput = {
      cluster,
      nodeEmbeddings,
      structuralScore,
      spectralScore,
      semanticScore,
    };

    const thoughtEv = engineState.thoughtDetector.evaluateCluster(input, now);
    if (thoughtEv) {
      if (thoughtEventHandler) {
        thoughtEventHandler(thoughtEv);
      }
      // INTERNAL THINKING: expand adjacency via LLM
      engineState.responseAccumulator.thoughtEvents.push(thoughtEv);

      // Fire-and-forget adjacency expansion (do not block rendering)
      void engineState.llm.expandAdjacency(thoughtEv).then((delta) => {
        applyAdjacencyDelta(delta, engineState.nodes, engineState.edges);
        if (adjacencyDeltaHandler) {
          adjacencyDeltaHandler(delta);
        }
      });
    }
  }

  // 3) Check if it’s time to articulate an answer to the user
  const articulation = engineState.respEngine.maybeArticulate(
    engineState.responseAccumulator,
    nodeEmbeddings,
    now,
  );

  if (articulation) {
    const question = engineState.currentUserQuestion;
    // Clear current state to await the next prompt and halt the thought loop
    engineState.responseAccumulator = null;
    engineState.currentUserQuestion = null;
    engineState.currentUserEmbedding = null;

    void engineState.llm.articulateResponse(articulation, question).then((responseText) => {
      if (articulationHandler) {
        articulationHandler(responseText);
      } else {
        // eslint-disable-next-line no-console
        console.log('Articulate response:', responseText);
      }
    });
  }
}

// ============================================================================
// Placeholder implementations (to be replaced with real logic)
// ============================================================================

// NOTE: These functions should be replaced with actual implementations
// from your existing graph / FFT / clustering logic.

function computeClustersFromLayoutAndAdjacency(
  nodes: EngineNodeMap,
  edges: Edge[],
  spectral: EngineSpectralMap,
): Cluster[] {
  const list = [...nodes.values()];
  const visited = new Set<string>();
  const clusters: Cluster[] = [];
  const adjacency = new Map<string, number>();

  for (const edge of edges) {
    const key = `${edge.src}->${edge.dst}`;
    adjacency.set(key, Math.max(edge.weight, adjacency.get(key) ?? 0));
  }

  const neighborThreshold = 0.55;
  const distanceThreshold = 0.45;

  const getNeighbors = (node: Node): string[] => {
    const neighbors: string[] = [];
    for (const other of list) {
      if (other.id === node.id) continue;
      const dx = node.position[0] - other.position[0];
      const dy = node.position[1] - other.position[1];
      const dist = Math.hypot(dx, dy);
      const wAB = adjacency.get(`${node.id}->${other.id}`) ?? 0;
      const wBA = adjacency.get(`${other.id}->${node.id}`) ?? 0;
      const maxW = Math.max(wAB, wBA);
      if (dist <= distanceThreshold || maxW >= neighborThreshold) {
        neighbors.push(other.id);
      }
    }
    return neighbors;
  };

  for (const node of list) {
    if (visited.has(node.id)) continue;
    const seeds = getNeighbors(node);
    if (seeds.length < 1) {
      visited.add(node.id);
      continue;
    }
    const clusterNodeIds = new Set<string>([node.id, ...seeds]);
    const queue = [...seeds];
    visited.add(node.id);

    while (queue.length) {
      const nid = queue.pop();
      if (!nid) continue;
      if (visited.has(nid)) continue;
      visited.add(nid);
      const nNode = nodes.get(nid);
      if (!nNode) continue;
      const neigh = getNeighbors(nNode);
      if (neigh.length >= 1) {
        for (const nn of neigh) {
          if (!clusterNodeIds.has(nn)) {
            clusterNodeIds.add(nn);
            queue.push(nn);
          }
        }
      }
    }

    const nodeIds = [...clusterNodeIds];
    const persistenceKey = nodeIds.slice().sort().join('|');
    const frames = (clusterPersistence.get(persistenceKey) ?? 0) + 1;
    clusterPersistence.set(persistenceKey, frames);

    const density = computeClusterDensity(nodeIds, edges);
    const spectralAggregate = aggregateSpectral(nodeIds, spectral);
    const semanticCoherence = computeClusterSemantic(nodeIds, nodes);

    clusters.push({
      id: persistenceKey,
      nodeIds,
      density,
      persistenceFrames: frames,
      spectral: spectralAggregate,
      semanticCoherence,
      novelty: Math.max(0, 1 - density * 0.5),
    });
  }

  return clusters;
}

function computeStructuralScore(cluster: Cluster, _edges: Edge[]): number {
  void _edges;
  const d = cluster.density;
  const p = Math.min(1, cluster.persistenceFrames / 10);
  return 0.5 * d + 0.5 * p;
}

function computeSpectralScore(
  cluster: Cluster,
  _spectral: EngineSpectralMap,
): number {
  void _spectral;
  const e = Math.min(1, cluster.spectral.energy);
  const bands = cluster.spectral.roleBandpower;
  const mean = bands.reduce((a, b) => a + b, 0) / (bands.length || 1);
  let varSum = 0;
  for (const b of bands) varSum += (b - mean) ** 2;
  const variance = bands.length ? varSum / bands.length : 0;
  const symmetry = 1 - Math.min(1, variance);
  return 0.6 * e + 0.4 * symmetry;
}

function computeSemanticScore(
  cluster: Cluster,
  nodeEmbeddings: Map<string, number[]>,
): number {
  const embs: number[][] = [];
  for (const nid of cluster.nodeIds) {
    const emb = nodeEmbeddings.get(nid);
    if (emb) embs.push(emb);
  }
  if (embs.length === 0) return 0;
  const centroid = averageEmbedding(embs);
  let totalSim = 0;
  let count = 0;
  for (const e of embs) {
    totalSim += cosine(e, centroid);
    count += 1;
  }
  if (count === 0) return 0;
  const coherence = totalSim / count; // 0..1
  return coherence;
}

function applyAdjacencyDelta(
  delta: AdjacencyDelta,
  nodes: EngineNodeMap,
  edges: Edge[],
): void {
  if (delta.nodes) {
    for (const n of delta.nodes) {
      if (!nodes.has(n.id)) {
        nodes.set(n.id, {
          id: n.id,
          label: n.label,
          embedding: n.hintEmbedding ?? [],
          position: [Math.random(), Math.random()],
          velocity: [0, 0],
        });
      }
    }
  }

  if (delta.edges) {
    for (const e of delta.edges) {
      edges.push({
        src: e.src,
        dst: e.dst,
        weight: e.weight,
        role: e.role,
        lastUpdated: Date.now(),
      });
    }
  }

  // OPTIONAL: trigger layout recomputation / adjacency matrix update etc.
}

function computeClusterDensity(nodeIds: string[], edges: Edge[]): number {
  if (nodeIds.length < 2) return 0;
  let internal = 0;
  const possible = (nodeIds.length * (nodeIds.length - 1)) / 2;
  const set = new Set(nodeIds);
  for (const edge of edges) {
    if (set.has(edge.src) && set.has(edge.dst)) {
      internal += Math.max(0, Math.min(1, edge.weight));
    }
  }
  return Math.min(1, internal / Math.max(1, possible));
}

function aggregateSpectral(
  nodeIds: string[],
  spectral: EngineSpectralMap,
): SpectralFeatures {
  const roleBands = [0, 0, 0, 0, 0];
  let energy = 0;
  let centroid = 0;
  let flatness = 0;
  let count = 0;

  for (const nid of nodeIds) {
    const spec = spectral.get(nid);
    if (!spec) continue;
    energy += spec.energy;
    centroid += spec.centroid;
    flatness += spec.flatness;
    spec.roleBandpower.forEach((v, i) => {
      roleBands[i] += v;
    });
    count += 1;
  }

  if (count === 0) {
    return {
      energy: 0,
      centroid: 0,
      flatness: 1,
      roleBandpower: roleBands,
    };
  }

  return {
    energy: energy / count,
    centroid: centroid / count,
    flatness: flatness / count,
    roleBandpower: roleBands.map(v => v / count),
  };
}

function computeClusterSemantic(nodeIds: string[], nodes: EngineNodeMap): number {
  const embs: number[][] = [];
  for (const nid of nodeIds) {
    const node = nodes.get(nid);
    if (node) embs.push(node.embedding);
  }
  if (embs.length === 0) return 0;
  const centroid = averageEmbedding(embs);
  let total = 0;
  let count = 0;
  for (const emb of embs) {
    total += cosine(emb, centroid);
    count += 1;
  }
  return count ? total / count : 0;
}
