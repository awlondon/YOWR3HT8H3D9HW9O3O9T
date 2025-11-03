export interface LocalHlsfAdjacencyTokenSummary {
  token: string;
  relationships: Record<string, { token: string; weight: number }[]>;
  attention: number;
  totalRelationships: number;
}

export interface LocalHlsfPromptRecord {
  id: string;
  text: string;
  tokens: string[];
  adjacencySeeds: string[];
  timestamp: string;
}

export interface LocalHlsfAdjacencySummary {
  id: string;
  tokenCount: number;
  summary: LocalHlsfAdjacencyTokenSummary[];
  updatedAt: string;
  label?: string;
}

export interface LocalHlsfMemoryState {
  prompts: LocalHlsfPromptRecord[];
  adjacencySummaries: Map<string, LocalHlsfAdjacencySummary>;
  lastPrompt?: LocalHlsfPromptRecord | null;
  lastAdjacency?: LocalHlsfAdjacencySummary | null;
}

export interface SessionManagerDeps {
  resolveLocalMemoryEdgeWeightFloor: () => number;
  limitAdjacencyEntryEdges: (
    entry: any,
    maxEdges?: number,
    priorityTokens?: Array<{ token?: string } | string>,
  ) => any;
  pruneRelationshipEdgesByWeight: (
    relationships: any,
    minWeight?: number,
  ) => { relationships: Record<string, { token: string; weight: number }[]>; totalWeight: number; totalEdges: number };
  windowRef?: typeof window;
}

export class SessionManager {
  private readonly deps: SessionManagerDeps;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  ensureLocalMemory(): LocalHlsfMemoryState | null {
    const win = this.deps.windowRef ?? (typeof window !== 'undefined' ? window : undefined);
    if (!win) return null;
    win.HLSF = win.HLSF || {};
    const hlsf = win.HLSF;
    if (!hlsf.localMemory || typeof hlsf.localMemory !== 'object') {
      hlsf.localMemory = {
        prompts: [],
        adjacencySummaries: new Map<string, LocalHlsfAdjacencySummary>(),
        lastPrompt: null,
        lastAdjacency: null,
      } satisfies LocalHlsfMemoryState;
    }
    const memory = hlsf.localMemory as LocalHlsfMemoryState;
    if (!Array.isArray(memory.prompts)) {
      memory.prompts = [];
    }
    if (!(memory.adjacencySummaries instanceof Map)) {
      memory.adjacencySummaries = new Map<string, LocalHlsfAdjacencySummary>();
    }
    return memory;
  }

  recordLocalPromptMemory(
    id: string,
    promptText: string,
    tokens: string[],
    adjacencyTargets: Array<{ token?: string; normalized?: string }> = [],
  ): LocalHlsfPromptRecord | null {
    const memory = this.ensureLocalMemory();
    if (!memory) return null;

    const seenTokens = new Set<string>();
    const normalizedTokens: string[] = [];
    for (const token of Array.isArray(tokens) ? tokens : []) {
      if (!token) continue;
      const value = String(token).trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seenTokens.has(key)) continue;
      seenTokens.add(key);
      normalizedTokens.push(value);
    }

    const adjacencySeeds: string[] = [];
    const seenAdjacency = new Set<string>();
    for (const target of Array.isArray(adjacencyTargets) ? adjacencyTargets : []) {
      if (!target) continue;
      const raw = typeof target === 'string'
        ? target
        : typeof target === 'object'
          ? String(target.token || target.normalized || '')
          : '';
      const value = raw.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seenAdjacency.has(key)) continue;
      seenAdjacency.add(key);
      adjacencySeeds.push(value);
    }

    const entry: LocalHlsfPromptRecord = {
      id,
      text: String(promptText || '').trim(),
      tokens: normalizedTokens,
      adjacencySeeds,
      timestamp: new Date().toISOString(),
    };

    memory.prompts.push(entry);
    while (memory.prompts.length > 100) {
      memory.prompts.shift();
    }
    memory.lastPrompt = entry;
    return entry;
  }

  summarizeAdjacencyMap(
    adjacencyMap: Map<string, any>,
    options: { limit?: number; edgesPerToken?: number } = {},
  ): LocalHlsfAdjacencyTokenSummary[] {
    if (!(adjacencyMap instanceof Map)) return [];

    const limit = Number.isFinite(options.limit) && options.limit
      ? Math.max(1, Math.floor(options.limit))
      : 20;
    const edgesPerToken = Number.isFinite(options.edgesPerToken) && options.edgesPerToken
      ? Math.max(1, Math.floor(options.edgesPerToken))
      : 6;
    const minEdgeWeight = this.deps.resolveLocalMemoryEdgeWeightFloor();

    const candidates: Array<{
      token: string;
      relationships: Record<string, { token: string; weight: number }[]>;
      attention: number;
      totalRelationships: number;
      score: number;
    }> = [];

    for (const [tokenKey, entry] of adjacencyMap.entries()) {
      if (!tokenKey || !entry) continue;
      const limited = this.deps.limitAdjacencyEntryEdges(entry, edgesPerToken);
      const { relationships, totalWeight, totalEdges } = this.deps.pruneRelationshipEdgesByWeight(
        limited.relationships,
        minEdgeWeight,
      );
      const attention = Number(limited.attention_score) || 0;
      const token = typeof limited.token === 'string' && limited.token.trim()
        ? limited.token.trim()
        : (typeof tokenKey === 'string' ? String(tokenKey).trim() : '');
      if (!token) continue;
      const hasRelationships = Object.keys(relationships).length > 0;
      if (!hasRelationships && attention <= 0) continue;
      const totalRelationships = totalEdges > 0
        ? totalEdges
        : (Number(limited.total_relationships) || 0);
      candidates.push({
        token,
        relationships,
        attention,
        totalRelationships,
        score: Math.max(attention, totalWeight),
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.attention !== a.attention) return b.attention - a.attention;
      return a.token.localeCompare(b.token, undefined, { sensitivity: 'base' });
    });

    const summary: LocalHlsfAdjacencyTokenSummary[] = [];
    for (const entry of candidates) {
      summary.push({
        token: entry.token,
        relationships: entry.relationships,
        attention: entry.attention,
        totalRelationships: entry.totalRelationships,
      });
      if (summary.length >= limit) break;
    }

    return summary;
  }

  recordAdjacencySummary(
    id: string,
    adjacencyMap: Map<string, any>,
    label = 'prompt-adjacency',
    options: { limit?: number; edgesPerToken?: number } = {},
  ): LocalHlsfAdjacencySummary | null {
    const memory = this.ensureLocalMemory();
    if (!memory || !(adjacencyMap instanceof Map)) return null;

    const summary = this.summarizeAdjacencyMap(adjacencyMap, options);
    const record: LocalHlsfAdjacencySummary = {
      id,
      label,
      tokenCount: summary.length,
      summary,
      updatedAt: new Date().toISOString(),
    };

    memory.adjacencySummaries.set(id, record);
    while (memory.adjacencySummaries.size > 50) {
      const oldest = memory.adjacencySummaries.keys().next();
      if (oldest.done) break;
      memory.adjacencySummaries.delete(oldest.value);
    }
    memory.lastAdjacency = record;
    return record;
  }
}
