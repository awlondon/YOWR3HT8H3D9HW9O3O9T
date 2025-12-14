export type ExpansionMode = 'prompt' | 'seedToken';

export interface SeedSphereConfig {
  seedToken: string;
  dimension: number;
  level: number;
  affinityThreshold: number;
  maxNodes: number;
  maxEdges: number;
  hiddenDepth: number;
  concurrency: number;
  salienceTopK: number;
  collapseRadius: number;
  allowSyntheticFallback?: boolean;
  convergenceThrottle?: Partial<ConvergenceThrottleConfig>;
}

export interface ConvergenceThrottleConfig {
  enabled: boolean;
  maxFieldNodes: number;
  maxFieldEdges: number;
  hysteresis: number;
  minCyclesBeforeThrottle: number;
  collapseRadius: number;
  reseedRingSize: number;
  reseedBranches: number;
  cooldownMs: number;
}

export const DEFAULT_CONVERGENCE_THROTTLE_CONFIG: ConvergenceThrottleConfig = {
  enabled: true,
  maxFieldNodes: 500,
  maxFieldEdges: 2500,
  hysteresis: 0.15,
  minCyclesBeforeThrottle: 1,
  collapseRadius: 2,
  reseedRingSize: 9,
  reseedBranches: 5,
  cooldownMs: 1500,
};
