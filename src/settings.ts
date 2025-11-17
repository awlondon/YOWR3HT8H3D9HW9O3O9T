export type SymbolEmitMode = 'paired' | 'standalone' | 'both';

export type PerformanceProfileId =
  | 'featherweight'
  | 'balanced'
  | 'research'
  | 'maximalist'
  | 'chaoslab';

export interface AdjacencySettings {
  maxAdjacencyLayers: number;
  maxAdjacencyDegreePerLayer: number[];
  maxAdjacencyDegree: number;
  adjacencySimilarityThreshold: number;
  adjacencyStrongSimilarityThreshold: number;
}

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

const baseAdjacencyDefaults: AdjacencySettings = {
  maxAdjacencyLayers: defaultPerformanceProfile.maxLayers,
  maxAdjacencyDegreePerLayer: [...defaultPerformanceProfile.maxDegreePerLayer],
  maxAdjacencyDegree: Math.max(1, defaultPerformanceProfile.maxDegreePerLayer[0] ?? 4),
  adjacencySimilarityThreshold: defaultPerformanceProfile.similarityThreshold,
  adjacencyStrongSimilarityThreshold: defaultPerformanceProfile.strongSimilarityThreshold,
};

const clamp01 = (value: unknown, fallback: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return Math.max(0, Math.min(1, fallback));
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
};

const toPositiveInt = (value: unknown, fallback: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return Math.max(1, Math.floor(fallback));
  const normalized = Math.floor(num);
  return normalized > 0 ? normalized : Math.max(1, Math.floor(fallback));
};

export function resolveAdjacencySettings(
  overrides: Partial<AdjacencySettings> = {},
): AdjacencySettings {
  const layers = toPositiveInt(overrides.maxAdjacencyLayers, baseAdjacencyDefaults.maxAdjacencyLayers);
  const degreeFallback = toPositiveInt(
    overrides.maxAdjacencyDegree ?? baseAdjacencyDefaults.maxAdjacencyDegree,
    baseAdjacencyDefaults.maxAdjacencyDegree,
  );
  const degreeSource = Array.isArray(overrides.maxAdjacencyDegreePerLayer)
    ? overrides.maxAdjacencyDegreePerLayer
    : baseAdjacencyDefaults.maxAdjacencyDegreePerLayer;
  const perLayer = Array.from({ length: layers }, (_, index) => {
    const raw = degreeSource[index] ?? degreeSource[degreeSource.length - 1] ?? degreeFallback;
    return toPositiveInt(raw, degreeFallback);
  });
  const similarity = clamp01(
    overrides.adjacencySimilarityThreshold,
    baseAdjacencyDefaults.adjacencySimilarityThreshold,
  );
  const strongRaw = clamp01(
    overrides.adjacencyStrongSimilarityThreshold,
    baseAdjacencyDefaults.adjacencyStrongSimilarityThreshold,
  );
  const strong = Math.max(similarity, strongRaw);

  return {
    maxAdjacencyLayers: layers,
    maxAdjacencyDegreePerLayer: perLayer,
    maxAdjacencyDegree: degreeFallback,
    adjacencySimilarityThreshold: similarity,
    adjacencyStrongSimilarityThreshold: strong,
  };
}

export const DEFAULT_ADJACENCY_SETTINGS = resolveAdjacencySettings();

const DEFAULT_SETTINGS = {
  tokenizeSymbols: true,
  symbolWeightScale: 0.35,
  symbolEmitMode: 'paired' as SymbolEmitMode,
  includeSymbolInSummaries: false,
  autoResetHlsfTransform: true,
  maxAdjacencyDepth: 4,
  maxAdjacencyDegree: DEFAULT_ADJACENCY_SETTINGS.maxAdjacencyDegree,
  maxAdjacencyEdgesMultiplier: 6,
  maxAdjacencyLayers: DEFAULT_ADJACENCY_SETTINGS.maxAdjacencyLayers,
  maxAdjacencyDegreePerLayer: [...DEFAULT_ADJACENCY_SETTINGS.maxAdjacencyDegreePerLayer],
  adjacencySimilarityThreshold: DEFAULT_ADJACENCY_SETTINGS.adjacencySimilarityThreshold,
  adjacencyStrongSimilarityThreshold: DEFAULT_ADJACENCY_SETTINGS.adjacencyStrongSimilarityThreshold,
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

export type SettingsShape = typeof DEFAULT_SETTINGS & Record<string, unknown>;

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

export const SETTINGS: SettingsShape = resolveGlobalSettings();
export type Settings = SettingsShape;

export type PerformanceProfile = 'low' | 'medium' | 'high';

export function getPerformanceProfile(deviceMemory: number | null): PerformanceProfile {
  if (deviceMemory != null && Number.isFinite(deviceMemory)) {
    if (deviceMemory <= 4) return 'low';
    if (deviceMemory >= 16) return 'high';
  }
  return 'medium';
}

export function getProfileSettings(profile: PerformanceProfile): Partial<Settings> {
  const map: Record<PerformanceProfile, PerformanceProfileConfig> = {
    low: PERFORMANCE_PROFILES.featherweight,
    medium: PERFORMANCE_PROFILES.balanced,
    high: PERFORMANCE_PROFILES.maximalist,
  };
  const config = map[profile] ?? PERFORMANCE_PROFILES.balanced;
  const adjacency = resolveAdjacencySettings({
    maxAdjacencyLayers: config.maxLayers,
    maxAdjacencyDegreePerLayer: config.maxDegreePerLayer,
    maxAdjacencyDegree: config.maxDegreePerLayer[0] ?? DEFAULT_ADJACENCY_SETTINGS.maxAdjacencyDegree,
    adjacencySimilarityThreshold: config.similarityThreshold,
    adjacencyStrongSimilarityThreshold: config.strongSimilarityThreshold,
  });
  return {
    performanceProfileId: config.id,
    branchingFactor: config.branchingFactor,
    maxNodes: config.maxNodes,
    maxEdges: config.maxEdges,
    maxRelationships: config.maxRelationships,
    maxRelationTypes: config.maxRelationTypes,
    pruneWeightThreshold: config.pruneWeightThreshold,
    maxAdjacencyLayers: adjacency.maxAdjacencyLayers,
    maxAdjacencyDegreePerLayer: adjacency.maxAdjacencyDegreePerLayer,
    maxAdjacencyDegree: adjacency.maxAdjacencyDegree,
    adjacencySimilarityThreshold: adjacency.adjacencySimilarityThreshold,
    adjacencyStrongSimilarityThreshold: adjacency.adjacencyStrongSimilarityThreshold,
  };
}
