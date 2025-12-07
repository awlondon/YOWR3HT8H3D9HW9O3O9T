export interface EmergentConfig {
  /** Optional maximum tokens to consider during decomposition. */
  maxTokens?: number;
  /** Whether to enable hidden reflections (step 4) for risk mapping. */
  enableReflection?: boolean;
  /** Optional knob to skip refinement step 5 for faster loops. */
  skipRefinement?: boolean;
}

export interface EmergentResult {
  trace: string[];
  structuredResponse: string;
  hlsf: HLSFGraph;
  meta?: { elapsedMs?: number; config?: EmergentConfig };
}

export interface DecompositionResult {
  tokens: string[];
  assumptions: string[];
}

export interface ClusterResult {
  clusters: ClusterSummary[];
}

export interface ClusterSummary {
  id: string;
  label: string;
  tokens: string[];
  rationale: string;
}

export interface HLSFGraph {
  nodes: HlsfNode[];
  edges: HlsfEdge[];
  notes?: string;
}

export interface HlsfNode {
  id: string;
  label: string;
  clusterId?: string;
}

export interface HlsfEdge {
  id: string;
  source: string;
  target: string;
  description?: string;
}

export interface ReflectionResult {
  insights: string[];
  interconnections: Array<{ from: string; to: string; note: string }>;
}

export interface StepResult {
  step: number;
  summary: string;
}

export interface SpectralFeatures {
  energy: number;
  centroid: number;
  flatness: number;
  roleBandpower: number[];
}

export interface RotationOptions {
  angularVelocity?: number;
  sampleIntervalMs?: number;
}

export interface RotationEvent {
  angle: number;
  spectral?: SpectralFeatures;
  timestamp: number;
}

export interface ThoughtEvent {
  id: string;
  clusterId: string;
  reason: string;
  timestamp: number;
}

export interface ArticulationEvent {
  id: string;
  message: string;
  timestamp: number;
  thoughts: ThoughtEvent[];
}
