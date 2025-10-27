export type AnchorEmbeddingMode = 'none' | 'subset' | 'separate';
export type AnchorLearnSetting = AnchorEmbeddingMode;
export type RelationParamMode = 'instances' | 'types' | 'none';
export type TransformMode = 'linear' | 'none';
export type HeadMode = 'linear' | 'mlp:none';

export interface ModelParamConfig {
  D: number;
  levels: number;
  last_level_components: number;
  learn_node_embeddings: boolean;
  learn_anchor_embeddings: AnchorLearnSetting;
  learn_edge_scalars: 0 | 1 | 2;
  relation_param_mode: RelationParamMode;
  num_relation_types?: number;
  per_level_transform: TransformMode;
  include_bias_in_transforms: boolean;
  head: HeadMode;
}

export interface DatabaseStatsForParams {
  graph_nodes?: number;
  anchors?: number;
  edge_types_enumerated?: number;
  total_relationships?: number;
  relation_types?: number;
}

export interface ModelParamComponents {
  node_embeddings: number;
  anchor_embeddings: number;
  edge_params: number;
  relationship_params: number;
  level_transforms: number;
  head_params: number;
}

export interface ModelParamDerivedCounts {
  N_nodes: number;
  N_anchors: number;
  N_edges: number;
  N_relationships: number;
  N_relation_types: number | null;
}

export type ModelParamHistoryDiff = {
  [K in keyof ModelParamConfigSnapshot]?: {
    previous: ModelParamConfigSnapshot[K] | null;
    current: ModelParamConfigSnapshot[K];
  };
};

export interface ModelParamHistoryEntry {
  timestamp: string;
  config: ModelParamConfigSnapshot;
  derived_counts: ModelParamDerivedCounts;
  total_parameters: number;
  assumptions: string[];
  diff: ModelParamHistoryDiff;
}

export interface ModelParamReport {
  config: ModelParamConfigSnapshot;
  derived_counts: ModelParamDerivedCounts;
  components: ModelParamComponents;
  total_parameters: number;
  assumptions: string[];
  formula_version: '1.0';
  history_entry?: ModelParamHistoryEntry;
}

export type ModelParamConfigSnapshot = Omit<ModelParamConfig, 'num_relation_types'> & {
  num_relation_types: number | null;
};

export const MODEL_PARAM_DEFAULTS: ModelParamConfig = {
  D: 100,
  levels: 3,
  last_level_components: 2,
  learn_node_embeddings: true,
  learn_anchor_embeddings: 'subset',
  learn_edge_scalars: 1,
  relation_param_mode: 'types',
  num_relation_types: undefined,
  per_level_transform: 'linear',
  include_bias_in_transforms: true,
  head: 'linear',
};

export const MODEL_PARAM_PRESETS: Record<string, Partial<ModelParamConfig>> = {
  minimal: {
    learn_node_embeddings: true,
    learn_anchor_embeddings: 'subset',
    learn_edge_scalars: 0,
    relation_param_mode: 'none',
    num_relation_types: undefined,
    per_level_transform: 'linear',
    include_bias_in_transforms: true,
    head: 'linear',
  },
  rich: {
    learn_node_embeddings: true,
    learn_anchor_embeddings: 'separate',
    learn_edge_scalars: 1,
    relation_param_mode: 'types',
  },
  'research-upper-bound': {
    learn_node_embeddings: true,
    learn_anchor_embeddings: 'separate',
    learn_edge_scalars: 2,
    relation_param_mode: 'instances',
  },
};

export interface FlagParseResult {
  config: ModelParamConfig;
  preset: string | null;
  warnings: string[];
  modified: Partial<Record<keyof ModelParamConfig, boolean>>;
  assumptions: string[];
}

export interface ResolveModelParamOptions {
  relationTypeCount?: number | null;
}

const MODEL_PARAM_HISTORY_MAX = 100;
const modelParamHistory: ModelParamHistoryEntry[] = [];

function getGlobalModelParamStore(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  const root = ((window as any).CognitionEngine = (window as any).CognitionEngine || {});
  root.modelParams = root.modelParams || {};
  return root.modelParams as Record<string, unknown>;
}

function diffModelParamSnapshot(
  previous: ModelParamConfigSnapshot | null,
  current: ModelParamConfigSnapshot,
): ModelParamHistoryDiff {
  const diff: ModelParamHistoryDiff = {};
  (Object.keys(current) as Array<keyof ModelParamConfigSnapshot>).forEach(key => {
    const prevValue = previous ? previous[key] : null;
    const currValue = current[key];
    if (previous && prevValue === currValue) return;
    const target = diff as Record<string, { previous: unknown; current: unknown }>;
    target[key as string] = { previous: prevValue ?? null, current: currValue };
  });
  return diff;
}

function recordModelParamHistoryEntry(report: ModelParamReport): ModelParamHistoryEntry {
  const previous = modelParamHistory.length ? modelParamHistory[modelParamHistory.length - 1].config : null;
  const entry: ModelParamHistoryEntry = {
    timestamp: new Date().toISOString(),
    config: report.config,
    derived_counts: report.derived_counts,
    total_parameters: report.total_parameters,
    assumptions: report.assumptions,
    diff: diffModelParamSnapshot(previous, report.config),
  };

  modelParamHistory.push(entry);
  while (modelParamHistory.length > MODEL_PARAM_HISTORY_MAX) {
    modelParamHistory.shift();
  }

  const globalStore = getGlobalModelParamStore();
  if (globalStore) {
    (globalStore as any).history = modelParamHistory.slice();
    (globalStore as any).last = entry;
  }

  return entry;
}

export function getModelParamHistory(): ModelParamHistoryEntry[] {
  return modelParamHistory.slice();
}

export function resolveModelParamConfig(
  base: ModelParamConfig | undefined,
  args: string[] = [],
  options: ResolveModelParamOptions = {}
): FlagParseResult {
  let config: ModelParamConfig = normalizeModelParamConfig({
    ...MODEL_PARAM_DEFAULTS,
    ...(base || {}),
  });
  let preset: string | null = null;
  const warnings: string[] = [];
  const modified: FlagParseResult['modified'] = {};

  const markModified = (key: keyof ModelParamConfig) => {
    modified[key] = true;
  };

  const consumeValue = (index: number): string | undefined => {
    if (index < 0 || index >= args.length) return undefined;
    const value = args[index];
    if (!value || value.startsWith('--')) return undefined;
    consumed.add(index);
    return value;
  };

  const consumed = new Set<number>();

  for (let i = 0; i < args.length; i += 1) {
    if (consumed.has(i)) continue;
    const raw = args[i];
    if (!raw) continue;
    if (!raw.startsWith('--')) {
      warnings.push(`ignored argument "${raw}"`);
      continue;
    }

    const flagParts = raw.split('=');
    const flag = flagParts[0];
    let value = flagParts.length > 1 ? flagParts.slice(1).join('=') : undefined;

    const lower = flag.toLowerCase();
    const nextValue = () => {
      if (value != null) return value;
      value = consumeValue(i + 1);
      return value;
    };

    switch (lower) {
      case '--preset': {
        const resolved = (nextValue() || '').toLowerCase();
        if (!resolved) {
          warnings.push('missing value for --preset');
          break;
        }
        const presetConfig = MODEL_PARAM_PRESETS[resolved];
        if (!presetConfig) {
          warnings.push(`unknown preset "${resolved}"`);
          break;
        }
        preset = resolved;
        config = normalizeModelParamConfig({
          ...config,
          ...presetConfig,
        });
        break;
      }
      case '--d': {
        const numeric = Number(nextValue());
        if (Number.isFinite(numeric) && numeric > 0) {
          config = { ...config, D: Math.round(numeric) };
          markModified('D');
        } else {
          warnings.push('invalid value for --D');
        }
        break;
      }
      case '--levels': {
        const numeric = Number(nextValue());
        if (Number.isFinite(numeric) && numeric >= 0) {
          config = { ...config, levels: Math.round(Math.max(0, numeric)) };
          markModified('levels');
        } else {
          warnings.push('invalid value for --levels');
        }
        break;
      }
      case '--last-components':
      case '--last-level-components': {
        const numeric = Number(nextValue());
        if (Number.isFinite(numeric) && numeric >= 0) {
          config = { ...config, last_level_components: Math.round(Math.max(0, numeric)) };
          markModified('last_level_components');
        } else {
          warnings.push('invalid value for --last-level-components');
        }
        break;
      }
      case '--anchors': {
        const resolved = (nextValue() || '').toLowerCase();
        if (resolved === 'subset' || resolved === 'separate' || resolved === 'none') {
          config = { ...config, learn_anchor_embeddings: resolved as AnchorEmbeddingMode };
          markModified('learn_anchor_embeddings');
        } else {
          warnings.push('invalid value for --anchors');
        }
        break;
      }
      case '--edge-scalars': {
        const numeric = Number(nextValue());
        if (Number.isFinite(numeric)) {
          const clamped = clampEdgeScalar(numeric);
          config = { ...config, learn_edge_scalars: clamped };
          markModified('learn_edge_scalars');
        } else {
          warnings.push('invalid value for --edge-scalars');
        }
        break;
      }
      case '--relations': {
        const resolved = (nextValue() || '').toLowerCase();
        if (resolved === 'instances' || resolved === 'types' || resolved === 'none') {
          config = { ...config, relation_param_mode: resolved as RelationParamMode };
          markModified('relation_param_mode');
        } else {
          warnings.push('invalid value for --relations');
        }
        break;
      }
      case '--relation-types': {
        const numeric = Number(nextValue());
        if (Number.isFinite(numeric) && numeric >= 0) {
          config = { ...config, num_relation_types: Math.round(Math.max(0, numeric)) };
          markModified('num_relation_types');
        } else {
          warnings.push('invalid value for --relation-types');
        }
        break;
      }
      case '--per-level-transform':
      case '--transform': {
        const resolved = (nextValue() || '').toLowerCase();
        if (resolved === 'linear' || resolved === 'none') {
          config = { ...config, per_level_transform: resolved as TransformMode };
          markModified('per_level_transform');
        } else {
          warnings.push('invalid value for --per-level-transform');
        }
        break;
      }
      case '--head': {
        const resolved = (nextValue() || '').toLowerCase();
        if (resolved === 'linear' || resolved === 'mlp:none') {
          config = { ...config, head: resolved as HeadMode };
          markModified('head');
        } else {
          warnings.push('invalid value for --head');
        }
        break;
      }
      case '--no-level-bias': {
        config = { ...config, include_bias_in_transforms: false };
        markModified('include_bias_in_transforms');
        break;
      }
      case '--level-bias': {
        config = { ...config, include_bias_in_transforms: true };
        markModified('include_bias_in_transforms');
        break;
      }
      case '--no-level-transform': {
        config = { ...config, per_level_transform: 'none' };
        markModified('per_level_transform');
        break;
      }
      case '--node-embeddings': {
        config = { ...config, learn_node_embeddings: true };
        markModified('learn_node_embeddings');
        break;
      }
      case '--no-node-embeddings': {
        config = { ...config, learn_node_embeddings: false };
        markModified('learn_node_embeddings');
        break;
      }
      default: {
        warnings.push(`unknown flag "${flag}"`);
        break;
      }
    }
  }

  let assumptions: string[] = [];
  if (config.relation_param_mode === 'types' && (!config.num_relation_types || config.num_relation_types <= 0)) {
    const fallback = options.relationTypeCount;
    if (fallback && fallback > 0) {
      config = { ...config, num_relation_types: Math.round(fallback) };
      assumptions.push(`relation types (T) = ${Math.round(fallback)}; derived from export statistics`);
    }
  }

  config = normalizeModelParamConfig(config);

  return { config, preset, warnings, modified, assumptions };
}

export interface ComputeModelParamOptions {
  fallbackRelationTypeCount?: number | null;
  assumptions?: string[];
}

export function computeModelParameters(
  stats: DatabaseStatsForParams,
  cfg: ModelParamConfig,
  options: ComputeModelParamOptions = {}
): ModelParamReport {
  const normalizedCfg = normalizeModelParamConfig(cfg);
  const assumptions = new Set<string>();
  for (const note of options.assumptions || []) {
    if (note) assumptions.add(note);
  }

  const N = sanitizeCount(stats.graph_nodes);
  const anchorsRaw = sanitizeCount(stats.anchors);
  const A = Math.min(anchorsRaw, N);
  const E = sanitizeCount(stats.edge_types_enumerated);
  const R = sanitizeCount(stats.total_relationships);

  const D = Math.max(1, Math.round(normalizedCfg.D));
  const L = Math.max(0, Math.round(normalizedCfg.levels));
  const C = Math.max(0, Math.round(normalizedCfg.last_level_components));

  const nodesParams = normalizedCfg.learn_node_embeddings ? N * D : 0;
  const anchorParams = normalizedCfg.learn_anchor_embeddings === 'separate' ? A * D : 0;
  if (normalizedCfg.learn_anchor_embeddings === 'subset') {
    assumptions.add('anchors are a subset of nodes; not double-counted');
  }

  const edgeScalarCount = clampEdgeScalar(normalizedCfg.learn_edge_scalars);
  const edgeParams = edgeScalarCount > 0 ? E * edgeScalarCount : 0;

  let relationMode: RelationParamMode = normalizedCfg.relation_param_mode;
  let relationTypes = normalizedCfg.num_relation_types;
  let relationParams = 0;

  if (relationMode === 'types') {
    const fallback = options.fallbackRelationTypeCount;
    if ((!relationTypes || relationTypes <= 0) && fallback && fallback > 0) {
      relationTypes = Math.round(fallback);
      assumptions.add(`relation types (T) = ${relationTypes}; derived from export statistics`);
    }
    if (!relationTypes || relationTypes <= 0) {
      relationMode = 'instances';
      relationTypes = undefined;
      assumptions.add('relation types unknown; counted per relationship instance');
    } else {
      relationParams = relationTypes * D;
      assumptions.add(`relation types (T) = ${relationTypes}; override if known`);
    }
  }

  if (relationMode === 'instances') {
    relationParams = R;
  } else if (relationMode === 'none') {
    relationParams = 0;
  }

  let levelParams = 0;
  if (normalizedCfg.per_level_transform === 'linear') {
    const perLevel = D * D + (normalizedCfg.include_bias_in_transforms ? D : 0);
    levelParams = L * perLevel;
    assumptions.add(
      normalizedCfg.include_bias_in_transforms
        ? 'per-level transforms are linear with bias'
        : 'per-level transforms are linear without bias'
    );
  }

  const headParams = normalizedCfg.head === 'linear' ? D * C + C : 0;

  const total = nodesParams + anchorParams + edgeParams + relationParams + levelParams + headParams;

  const snapshot: ModelParamConfigSnapshot = {
    D,
    levels: L,
    last_level_components: C,
    learn_node_embeddings: normalizedCfg.learn_node_embeddings,
    learn_anchor_embeddings: normalizedCfg.learn_anchor_embeddings,
    learn_edge_scalars: edgeScalarCount,
    relation_param_mode: relationMode,
    num_relation_types: relationMode === 'types' ? (relationTypes ?? null) : null,
    per_level_transform: normalizedCfg.per_level_transform,
    include_bias_in_transforms: normalizedCfg.include_bias_in_transforms,
    head: normalizedCfg.head,
  };

  const derived: ModelParamDerivedCounts = {
    N_nodes: N,
    N_anchors: A,
    N_edges: E,
    N_relationships: R,
    N_relation_types: snapshot.num_relation_types,
  };

  const report: ModelParamReport = {
    config: snapshot,
    derived_counts: derived,
    components: {
      node_embeddings: nodesParams,
      anchor_embeddings: anchorParams,
      edge_params: edgeParams,
      relationship_params: relationParams,
      level_transforms: levelParams,
      head_params: headParams,
    },
    total_parameters: total,
    assumptions: Array.from(assumptions.values()),
    formula_version: '1.0',
  };

  report.history_entry = recordModelParamHistoryEntry(report);
  return report;
}

function normalizeModelParamConfig(config: ModelParamConfig): ModelParamConfig {
  return {
    D: Math.max(1, Math.round(Number(config.D) || MODEL_PARAM_DEFAULTS.D)),
    levels: Math.max(0, Math.round(Number(config.levels) || 0)),
    last_level_components: Math.max(0, Math.round(Number(config.last_level_components) || 0)),
    learn_node_embeddings: config.learn_node_embeddings !== false,
    learn_anchor_embeddings: normalizeAnchorMode(config.learn_anchor_embeddings),
    learn_edge_scalars: clampEdgeScalar(config.learn_edge_scalars) as 0 | 1 | 2,
    relation_param_mode: normalizeRelationMode(config.relation_param_mode),
    num_relation_types:
      typeof config.num_relation_types === 'number' && Number.isFinite(config.num_relation_types)
        ? Math.max(0, Math.round(config.num_relation_types))
        : undefined,
    per_level_transform: config.per_level_transform === 'none' ? 'none' : 'linear',
    include_bias_in_transforms: config.include_bias_in_transforms !== false,
    head: config.head === 'mlp:none' ? 'mlp:none' : 'linear',
  };
}

function normalizeAnchorMode(mode: string | undefined): AnchorLearnSetting {
  switch (mode) {
    case 'none':
    case 'subset':
    case 'separate':
      return mode;
    default:
      return MODEL_PARAM_DEFAULTS.learn_anchor_embeddings;
  }
}

function normalizeRelationMode(mode: string | undefined): RelationParamMode {
  switch (mode) {
    case 'instances':
    case 'types':
    case 'none':
      return mode;
    default:
      return MODEL_PARAM_DEFAULTS.relation_param_mode;
  }
}

function clampEdgeScalar(value: number | undefined): 0 | 1 | 2 {
  if (!Number.isFinite(Number(value))) return MODEL_PARAM_DEFAULTS.learn_edge_scalars;
  const num = Math.round(Number(value));
  if (num <= 0) return 0;
  if (num === 1) return 1;
  return 2;
}

function sanitizeCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.max(0, Math.floor(Number(value)));
  return Number.isFinite(normalized) ? normalized : 0;
}
