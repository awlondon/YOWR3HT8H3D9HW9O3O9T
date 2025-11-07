import { SETTINGS } from '../../settings';
import type { Settings } from '../../settings';
import { runPipeline } from '../../engine/pipeline';
import { PipelineWorkerClient } from '../../engine/pipelineClient';
import type { TelemetryHook } from '../../types/pipeline-messages';
import type { UIUpdater } from '../ui/uiUpdater';
import { defaultUIUpdater } from '../ui/uiUpdater';

export interface PricingModel {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface EngineConfig {
  MAX_TOKENS_PER_PROMPT: number;
  MAX_TOKENS_PER_RESPONSE: number;
  INPUT_WORD_LIMIT: number;
  DOCUMENT_WORD_LIMIT: number;
  PROMPT_LOG_LIMIT: number;
  ORIGINAL_OUTPUT_WORD_LIMIT: number;
  LOCAL_OUTPUT_WORD_LIMIT: number;
  LOCAL_RESPONSE_WORD_LIMIT: number;
  MAX_CONCURRENCY: number;
  MAX_RETRY_ATTEMPTS: number;
  RETRY_BASE_DELAY_MS: number;
  DOCUMENT_CHUNK_SIZE: number;
  CACHE_SEED_LIMIT: number;
  DEFAULT_MODEL: string;
  MODEL_PRICING: Record<string, PricingModel>;
  ESTIMATED_COMPLETION_RATIO: number;
  ADJACENCY_TOKEN_ESTIMATES: { prompt: number; completion: number };
  ADJACENCY_RECURSION_DEPTH: number;
  ADJACENCY_EDGES_PER_LEVEL: number;
  ADJACENCY_SPAWN_LIMIT: number;
  ADJACENCY_RELATIONSHIPS_PER_NODE: number;
  NETWORK_RETRY_BACKOFF_MS: number;
}

export interface PipelineRunOptions {
  signal?: AbortSignal | null;
  telemetry?: TelemetryHook;
}

export const MAX_RECURSION_DEPTH = 8;
export const MAX_LEVEL_UP_SEEDS = 64;
export const DEFAULT_HLSF_RELATIONSHIP_LIMIT = 1000;

const ENGINE_CONFIG: EngineConfig = {
  MAX_TOKENS_PER_PROMPT: 500,
  MAX_TOKENS_PER_RESPONSE: 1500,
  INPUT_WORD_LIMIT: 100,
  DOCUMENT_WORD_LIMIT: 350,
  PROMPT_LOG_LIMIT: 250,
  ORIGINAL_OUTPUT_WORD_LIMIT: 200,
  LOCAL_OUTPUT_WORD_LIMIT: 100,
  LOCAL_RESPONSE_WORD_LIMIT: 20,
  MAX_CONCURRENCY: 5,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 500,
  DOCUMENT_CHUNK_SIZE: 8,
  CACHE_SEED_LIMIT: 8000,
  DEFAULT_MODEL: 'gpt-4o-mini',
  MODEL_PRICING: {
    default: { inputPerMillion: 0.15, outputPerMillion: 0.60 },
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  },
  ESTIMATED_COMPLETION_RATIO: 0.7,
  ADJACENCY_TOKEN_ESTIMATES: {
    prompt: 220,
    completion: 320,
  },
  ADJACENCY_RECURSION_DEPTH: 3,
  ADJACENCY_EDGES_PER_LEVEL: 4,
  ADJACENCY_SPAWN_LIMIT: 2,
  ADJACENCY_RELATIONSHIPS_PER_NODE: 8,
  NETWORK_RETRY_BACKOFF_MS: 5000,
};

export function resolveHlsfRelationshipBudget(overrideLimit: unknown = null): number {
  if (overrideLimit === Infinity) return Infinity;
  if (typeof overrideLimit === 'string') {
    const trimmed = overrideLimit.trim();
    if (trimmed.toLowerCase() === 'infinity') return Infinity;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.max(0, Math.floor(numeric));
    }
  } else if (Number.isFinite(Number(overrideLimit))) {
    return Math.max(0, Math.floor(Number(overrideLimit)));
  }

  if (typeof window !== 'undefined') {
    const config = window?.HLSF?.config || {};
    const raw = config.relationshipBudget ?? config.relationshipLimit;
    if (raw === Infinity) return Infinity;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) {
        return DEFAULT_HLSF_RELATIONSHIP_LIMIT;
      }
      if (trimmed.toLowerCase() === 'infinity') return Infinity;
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return Math.max(0, Math.floor(numeric));
      }
      return DEFAULT_HLSF_RELATIONSHIP_LIMIT;
    }
    if (Number.isFinite(raw)) {
      return Math.max(0, Math.floor(Number(raw)));
    }
  }

  return DEFAULT_HLSF_RELATIONSHIP_LIMIT;
}

export class SessionManager {
  public readonly config: EngineConfig;
  private pipelineWorkerClient: PipelineWorkerClient | null = null;

  constructor(private readonly uiUpdater: UIUpdater = defaultUIUpdater, initialConfig: EngineConfig = ENGINE_CONFIG) {
    this.config = { ...initialConfig };
  }

  applyPerformanceCaps(settingsOverride: Partial<Settings> | null = null): void {
    const source = settingsOverride || this.activeSettings() || {};
    const branching = Math.max(2, Math.floor(Number((source as any).branchingFactor) || 2));
    const nodeCap = Math.max(1, Math.floor(Number((source as any).maxNodes) || 1600));
    const edgeCap = Math.max(branching * 2, Math.floor(Number((source as any).maxEdges) || 6400));
    const relationCap = Math.max(2, Math.floor(Number((source as any).maxRelationTypes) || 40));
    const rawRelationship = (source as any).maxRelationships;
    const numericRelationship = Number(rawRelationship);
    const relationshipBudget = resolveHlsfRelationshipBudget(
      Number.isFinite(numericRelationship) ? numericRelationship : rawRelationship ?? null,
    );
    const pruneThreshold = Number.isFinite(Number((source as any).pruneWeightThreshold))
      ? Math.max(0, Number((source as any).pruneWeightThreshold))
      : 0.18;

    this.config.ADJACENCY_SPAWN_LIMIT = branching;
    this.config.ADJACENCY_RELATIONSHIPS_PER_NODE = relationCap;
    const derivedEdgesPerLevel = Math.max(branching, Math.floor(edgeCap / Math.max(1, nodeCap)));
    this.config.ADJACENCY_EDGES_PER_LEVEL = derivedEdgesPerLevel;

    if (typeof window !== 'undefined') {
      window.HLSF = window.HLSF || {};
      const runtime = (window.HLSF.config = window.HLSF.config || {});
      runtime.liveTokenCap = nodeCap;
      runtime.maxNodeCount = nodeCap;
      runtime.maxEdgeCount = edgeCap;
      runtime.maxRelationshipCount = relationshipBudget;
      runtime.maxRelationTypes = relationCap;
      runtime.pruneWeightThreshold = pruneThreshold;
      runtime.liveEdgeWeightMin = pruneThreshold;
      runtime.localMemoryEdgeWeightMin = pruneThreshold;
      runtime.relationshipBudget = relationshipBudget;
      runtime.relationshipLimit = relationshipBudget;
    }

    if (typeof window !== 'undefined') {
      window.SETTINGS = Object.assign(window.SETTINGS || {}, source, {
        branchingFactor: branching,
        maxNodes: nodeCap,
        maxEdges: edgeCap,
        maxRelationships: rawRelationship ?? numericRelationship ?? relationshipBudget,
        maxRelationTypes: Math.max(50, relationCap),
        pruneWeightThreshold: pruneThreshold,
      });
    }

    this.uiUpdater.updateHlsfLimitSummary({
      nodes: nodeCap,
      edges: edgeCap,
      relationships: relationshipBudget,
    });
  }

  applyRecursionDepthSetting(nextDepth: unknown): number {
    const clamped = this.clampRecursionDepth(nextDepth);
    if (typeof window !== 'undefined') {
      (window as any).HLSF = (window as any).HLSF || {};
      const config = (((window as any).HLSF as any).config = ((window as any).HLSF as any).config || {});
      config.adjacencyRecursionDepth = clamped;
    }
    this.config.ADJACENCY_RECURSION_DEPTH = clamped;
    return clamped;
  }

  getRecursionDepthSetting(): number {
    if (typeof window !== 'undefined' && window && (window as any).HLSF) {
      const config = (window as any).HLSF.config;
      if (config && Object.prototype.hasOwnProperty.call(config, 'adjacencyRecursionDepth')) {
        return this.clampRecursionDepth(config.adjacencyRecursionDepth);
      }
    }
    return this.clampRecursionDepth(this.config.ADJACENCY_RECURSION_DEPTH);
  }

  async executePipeline(text: string, cfg: Settings, options: PipelineRunOptions = {}) {
    const client = this.getPipelineWorkerClient();
    if (client) {
      return client.run(
        { text, options: cfg },
        { telemetry: options.telemetry, signal: options.signal ?? undefined },
      );
    }

    if (options.signal?.aborted) {
      const abortError = new Error('Pipeline aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    const result = runPipeline(text, cfg, {
      telemetry: options.telemetry,
      shouldAbort: () => options.signal?.aborted === true,
    });

    return { result };
  }

  activeSettings(): Settings {
    if (typeof window !== 'undefined' && window && (window as any).SETTINGS) {
      return (window as any).SETTINGS;
    }
    return SETTINGS;
  }

  private clampRecursionDepth(value: unknown): number {
    if (value === Infinity || value === 'Infinity') {
      return MAX_RECURSION_DEPTH;
    }
    const numeric = Math.floor(Number(value));
    if (!Number.isFinite(numeric)) {
      const fallback = Math.floor(Number(this.config.ADJACENCY_RECURSION_DEPTH));
      if (!Number.isFinite(fallback)) {
        return 0;
      }
      return Math.min(MAX_RECURSION_DEPTH, Math.max(0, fallback));
    }
    return Math.min(MAX_RECURSION_DEPTH, Math.max(0, numeric));
  }

  private getPipelineWorkerClient(): PipelineWorkerClient | null {
    if (this.pipelineWorkerClient) {
      return this.pipelineWorkerClient;
    }
    if (typeof Worker === 'undefined') {
      return null;
    }
    try {
      this.pipelineWorkerClient = new PipelineWorkerClient();
    } catch (err) {
      console.warn('Pipeline worker initialization failed:', err);
      this.pipelineWorkerClient = null;
    }
    return this.pipelineWorkerClient;
  }
}

export const sessionManager = new SessionManager();
export const CONFIG = sessionManager.config;

export const applyPerformanceCaps = (settingsOverride: Partial<Settings> | null = null) =>
  sessionManager.applyPerformanceCaps(settingsOverride);
export const applyRecursionDepthSetting = (nextDepth: unknown) => sessionManager.applyRecursionDepthSetting(nextDepth);
export const getRecursionDepthSetting = () => sessionManager.getRecursionDepthSetting();
export const executePipeline = (
  text: string,
  cfg: Settings,
  options: PipelineRunOptions = {},
) => sessionManager.executePipeline(text, cfg, options);
export const activeSettings = () => sessionManager.activeSettings();
