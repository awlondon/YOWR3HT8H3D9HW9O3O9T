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
}
