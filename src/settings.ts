export type SymbolEmitMode = 'paired' | 'standalone' | 'both';

export type PerformanceProfileId =
  | 'featherweight'
  | 'balanced'
  | 'research'
  | 'maximalist'
  | 'chaoslab';

export interface PerformanceProfileConfig {
  id: PerformanceProfileId;
  label: string;
  branchingFactor: number;
  maxNodes: number;
  maxEdges: number;
  maxRelationships: number;
  maxRelationTypes: number;
  pruneWeightThreshold: number;
  maxLayers: number;
  maxDegreePerLayer: number[];
  similarityThreshold: number;
  strongSimilarityThreshold: number;
}

export const PERFORMANCE_PROFILES: Record<PerformanceProfileId, PerformanceProfileConfig> = {
  featherweight: {
    id: 'featherweight',
    label: 'Featherweight',
    branchingFactor: 2,
    maxNodes: 600,
    maxEdges: 1800,
    maxRelationships: 2200,
    maxRelationTypes: 24,
    pruneWeightThreshold: 0.22,
    maxLayers: 3,
    maxDegreePerLayer: [4, 2, 1],
    similarityThreshold: 0.35,
    strongSimilarityThreshold: 0.85,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    branchingFactor: 2,
    maxNodes: 1600,
    maxEdges: 6400,
    maxRelationships: 4200,
    maxRelationTypes: 40,
    pruneWeightThreshold: 0.18,
    maxLayers: 3,
    maxDegreePerLayer: [5, 3, 2],
    similarityThreshold: 0.3,
    strongSimilarityThreshold: 0.82,
  },
  research: {
    id: 'research',
    label: 'Research',
    branchingFactor: 2,
    maxNodes: 2400,
    maxEdges: 9600,
    maxRelationships: 5200,
    maxRelationTypes: 50,
    pruneWeightThreshold: 0.16,
    maxLayers: 4,
    maxDegreePerLayer: [6, 4, 3, 2],
    similarityThreshold: 0.28,
    strongSimilarityThreshold: 0.8,
  },
  maximalist: {
    id: 'maximalist',
    label: 'Maximalist',
    branchingFactor: 2,
    maxNodes: 3200,
    maxEdges: 12800,
    maxRelationships: 6400,
    maxRelationTypes: 50,
    pruneWeightThreshold: 0.15,
    maxLayers: 4,
    maxDegreePerLayer: [6, 5, 4, 3],
    similarityThreshold: 0.26,
    strongSimilarityThreshold: 0.78,
  },
  chaoslab: {
    id: 'chaoslab',
    label: 'ChaosLab',
    branchingFactor: 3,
    maxNodes: 1400,
    maxEdges: 5600,
    maxRelationships: 4800,
    maxRelationTypes: 50,
    pruneWeightThreshold: 0.26,
    maxLayers: 3,
    maxDegreePerLayer: [5, 4, 2],
    similarityThreshold: 0.32,
    strongSimilarityThreshold: 0.84,
  },
};

function normalizePerformanceProfileId(id?: string | null): PerformanceProfileId | null {
  if (typeof id !== 'string') {
    return null;
  }

  const trimmed = id.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const directMatch = trimmed as PerformanceProfileId;
  if (PERFORMANCE_PROFILES[directMatch]) {
    return directMatch;
  }

  const sanitized = trimmed.replace(/[^a-z]/g, '') as PerformanceProfileId;
  if (sanitized && PERFORMANCE_PROFILES[sanitized]) {
    return sanitized;
  }

  return null;
}

export function resolvePerformanceProfile(id?: string | null): PerformanceProfileConfig {
  const normalized = normalizePerformanceProfileId(id);
  if (normalized) {
    return PERFORMANCE_PROFILES[normalized];
  }
  return PERFORMANCE_PROFILES.balanced;
}

export function pickPerformanceProfileForDevice(): PerformanceProfileConfig {
  if (typeof navigator === 'undefined') {
    return PERFORMANCE_PROFILES.balanced;
  }

  const memory = Number((navigator as any).deviceMemory) || 0;
  const cores = Number(navigator.hardwareConcurrency) || 0;

  if ((memory && memory <= 4) || (cores && cores <= 4)) {
    return PERFORMANCE_PROFILES.featherweight;
  }

  if ((memory && memory >= 16) || (memory >= 12 && cores >= 10)) {
    return PERFORMANCE_PROFILES.maximalist;
  }

  if (cores >= 12 && memory >= 8) {
    return PERFORMANCE_PROFILES.chaoslab;
  }

  if ((memory && memory <= 8) || (cores && cores <= 6)) {
    return PERFORMANCE_PROFILES.balanced;
  }

  return PERFORMANCE_PROFILES.research;
}

const defaultPerformanceProfile = pickPerformanceProfileForDevice();

const DEFAULT_SETTINGS = {
  tokenizeSymbols: true,
  symbolWeightScale: 0.35,
  symbolEmitMode: 'paired' as SymbolEmitMode,
  includeSymbolInSummaries: false,
  maxAdjacencyDepth: 4,
  maxAdjacencyDegree: 4,
  maxAdjacencyEdgesMultiplier: 6,
  maxAdjacencyLayers: defaultPerformanceProfile.maxLayers,
  maxAdjacencyDegreePerLayer: defaultPerformanceProfile.maxDegreePerLayer,
  adjacencySimilarityThreshold: defaultPerformanceProfile.similarityThreshold,
  adjacencyStrongSimilarityThreshold: defaultPerformanceProfile.strongSimilarityThreshold,
  promptAdjacencyChunkSize: 8,
  secureBillingOnly: true,
  performanceProfileId: defaultPerformanceProfile.id,
  branchingFactor: defaultPerformanceProfile.branchingFactor,
  maxNodes: defaultPerformanceProfile.maxNodes,
  maxEdges: defaultPerformanceProfile.maxEdges,
  maxRelationships: defaultPerformanceProfile.maxRelationships,
  maxRelationTypes: defaultPerformanceProfile.maxRelationTypes,
  pruneWeightThreshold: defaultPerformanceProfile.pruneWeightThreshold,
};

type SettingsShape = typeof DEFAULT_SETTINGS & Record<string, unknown>;

function resolveGlobalSettings(): SettingsShape {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }

  const existing = (window as any).SETTINGS || {};
  const merged = { ...DEFAULT_SETTINGS, ...existing } as SettingsShape;
  (window as any).SETTINGS = merged;
  (window as any).CognitionEngine = (window as any).CognitionEngine || {};
  (window as any).CognitionEngine.settings = merged;
  return merged;
}

export const SETTINGS = resolveGlobalSettings();
export type Settings = typeof SETTINGS;
