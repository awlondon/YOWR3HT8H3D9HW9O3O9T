/**
 * Core types for HLSF cognitive engine: nodes, edges, spectra, clusters,
 * ThoughtEvents, and ArticulationEvents.
 */

export type NodeId = string;

export type EdgeRole = string;

export interface Node {
  id: NodeId;
  label: string;
  embedding: number[]; // normalized vector
  position: [number, number];
  velocity: [number, number];
}

export interface Edge {
  src: NodeId;
  dst: NodeId;
  weight: number; // 0..1
  role: EdgeRole;
  lastUpdated: number; // timestamp (ms)
}

export interface HlsfNode {
  id: string;
  label: string;
  tokenType?: string;
  tokens?: string[];
  embedding: number[];
}

export interface HlsfEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  relation?: string;
  family?: string;
  meta?: Record<string, unknown>;
}

export interface HlsfGraph {
  nodes: HlsfNode[];
  edges: HlsfEdge[];
  metadata?: Record<string, unknown>;
}

export interface ReasoningStep {
  stage: string;
  note: string;
}

export interface SpectralFeatures {
  energy: number; // total bandpower
  centroid: number; // frequency centroid
  flatness: number; // spectral flatness
  roleBandpower: number[]; // length 5, aligned with EdgeRole order
}

export interface Cluster {
  id: string;
  nodeIds: NodeId[];
  density: number; // 0..1 graph density
  persistenceFrames: number; // how many frames it has existed
  spectral: SpectralFeatures; // aggregated over member nodes
  semanticCoherence: number; // 0..1
  novelty: number; // 0..1 vs recent thoughts
}

export interface ThoughtEvent {
  id: string;
  type: 'cluster_thought' | 'path_thought';
  timestamp: number;
  cluster: Cluster;
  thoughtScore: number; // 0..1

  // For path_thought: node flying through multiple clusters
  pathNodeIds?: NodeId[];
}

export interface NodeCooldownState {
  lastThoughtAt: number;
  cooldownMs: number;
}

export interface AdjacencyDeltaNode {
  id: NodeId;
  label: string;
  hintEmbedding?: number[];
  meta?: Record<string, unknown>;
}

export interface AdjacencyDeltaEdge {
  src: NodeId;
  dst: NodeId;
  weight: number;
  role: EdgeRole;
  meta?: Record<string, unknown>;
}

export interface AdjacencyDelta {
  nodes?: AdjacencyDeltaNode[];
  edges?: AdjacencyDeltaEdge[];
  notes?: string; // optional short hypothesis
}

export interface ArticulationEvent {
  id: string;
  timestamp: number;
  articulationScore: number;
  selectedThoughts: ThoughtEvent[];
}

// Represents thought events accumulated while answering a single user query
export interface ResponseAccumulator {
  lastResponseAt: number;
  queryEmbedding: number[];
  thoughtEvents: ThoughtEvent[];
  tokenFrequency: Map<string, number>;
}
