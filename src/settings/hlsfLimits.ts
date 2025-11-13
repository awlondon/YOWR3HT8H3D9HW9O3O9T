export type HlsfLimits = {
  branchingFactor: number;
  maxNodes: number;
  maxEdges: number;
  maxRelationTypes: number;
  pruneWeightThreshold: number; // 0..1 weight scale
  maxLayers: number;
  maxDegreePerLayer: number[];
  similarityThreshold: number;
  strongSimilarityThreshold: number;
};

export const PRESETS: Record<string, HlsfLimits> = {
  Featherweight: {
    branchingFactor: 2,
    maxNodes: 600,
    maxEdges: 1800,
    maxRelationTypes: 24,
    pruneWeightThreshold: 0.22,
    maxLayers: 3,
    maxDegreePerLayer: [4, 2, 1],
    similarityThreshold: 0.35,
    strongSimilarityThreshold: 0.85,
  },
  Balanced: {
    branchingFactor: 2,
    maxNodes: 1600,
    maxEdges: 6400,
    maxRelationTypes: 40,
    pruneWeightThreshold: 0.18,
    maxLayers: 3,
    maxDegreePerLayer: [5, 3, 2],
    similarityThreshold: 0.3,
    strongSimilarityThreshold: 0.82,
  },
  Research: {
    branchingFactor: 2,
    maxNodes: 2400,
    maxEdges: 9600,
    maxRelationTypes: 50,
    pruneWeightThreshold: 0.16,
    maxLayers: 4,
    maxDegreePerLayer: [6, 4, 3, 2],
    similarityThreshold: 0.28,
    strongSimilarityThreshold: 0.8,
  },
  Maximalist: {
    branchingFactor: 2,
    maxNodes: 3200,
    maxEdges: 12800,
    maxRelationTypes: 50,
    pruneWeightThreshold: 0.15,
    maxLayers: 4,
    maxDegreePerLayer: [6, 5, 4, 3],
    similarityThreshold: 0.26,
    strongSimilarityThreshold: 0.78,
  },
  ChaosLab: {
    branchingFactor: 3,
    maxNodes: 1400,
    maxEdges: 5600,
    maxRelationTypes: 50,
    pruneWeightThreshold: 0.26,
    maxLayers: 3,
    maxDegreePerLayer: [5, 4, 2],
    similarityThreshold: 0.32,
    strongSimilarityThreshold: 0.84,
  },
};

export function autotuneLimits(): HlsfLimits {
  const dm = (navigator as any).deviceMemory || 8;
  if (dm <= 4) return PRESETS.Featherweight;
  if (dm >= 16) return PRESETS.Maximalist;
  return PRESETS.Balanced;
}
