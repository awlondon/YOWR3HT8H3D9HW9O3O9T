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
} from './cognitionTypes.js';
import { ThoughtDetector, type ClusterFeaturesInput } from './thoughtDetector.js';
import { ResponseAccumulatorEngine } from './responseAccumulator.js';
import { StubLLMClient } from './llmClient.js';
import { averageEmbedding, cosine } from './vectorUtils.js';

type EngineNodeMap = Map<string, Node>;

type EngineSpectralMap = Map<string, SpectralFeatures>;

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
      // INTERNAL THINKING: expand adjacency via LLM
      engineState.responseAccumulator.thoughtEvents.push(thoughtEv);

      // Fire-and-forget adjacency expansion (do not block rendering)
      void engineState.llm.expandAdjacency(thoughtEv).then((delta) => {
        applyAdjacencyDelta(delta, engineState.nodes, engineState.edges);
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
      // TODO: route responseText to UI (chat panel / log / etc.)
      // eslint-disable-next-line no-console
      console.log('Articulate response:', responseText);
    });
  }
}

// ============================================================================
// Placeholder implementations (to be replaced with real logic)
// ============================================================================

// NOTE: These functions should be replaced with actual implementations
// from your existing graph / FFT / clustering logic.

function computeClustersFromLayoutAndAdjacency(
  _nodes: EngineNodeMap,
  _edges: Edge[],
  _spectral: EngineSpectralMap,
): Cluster[] {
  void _nodes;
  void _edges;
  void _spectral;
  // TODO: integrate your existing clustering (Louvain, DBSCAN on layout, etc.)
  return [];
}

function computeStructuralScore(cluster: Cluster, _edges: Edge[]): number {
  void _edges;
  // TODO: use cluster.density and persistenceFrames, possibly normalized
  const d = cluster.density;
  const p = Math.min(1, cluster.persistenceFrames / 10);
  return 0.5 * d + 0.5 * p;
}

function computeSpectralScore(
  cluster: Cluster,
  _spectral: EngineSpectralMap,
): number {
  void _spectral;
  // TODO: use cluster.spectral.energy / symmetry across roleBandpower
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
