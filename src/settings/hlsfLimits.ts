export type HlsfLimits = {
  branchingFactor: number;
  maxNodes: number;
  maxEdges: number;
  maxRelationTypes: number;
  pruneWeightThreshold: number; // 0..1 weight scale
};

export const PRESETS: Record<string, HlsfLimits> = {
  Featherweight: { branchingFactor: 2, maxNodes: 600,  maxEdges: 1800,  maxRelationTypes: 24, pruneWeightThreshold: 0.22 },
  Balanced:     { branchingFactor: 2, maxNodes: 1600, maxEdges: 6400,  maxRelationTypes: 40, pruneWeightThreshold: 0.18 },
  Research:     { branchingFactor: 2, maxNodes: 2400, maxEdges: 9600,  maxRelationTypes: 50, pruneWeightThreshold: 0.16 },
  Maximalist:   { branchingFactor: 2, maxNodes: 3200, maxEdges: 12800, maxRelationTypes: 50, pruneWeightThreshold: 0.15 },
  ChaosLab:     { branchingFactor: 3, maxNodes: 1400, maxEdges: 5600,  maxRelationTypes: 50, pruneWeightThreshold: 0.26 },
};

export function autotuneLimits(): HlsfLimits {
  const dm = (navigator as any).deviceMemory || 8;
  if (dm <= 4) return PRESETS.Featherweight;
  if (dm >= 16) return PRESETS.Maximalist;
  return PRESETS.Balanced;
}
