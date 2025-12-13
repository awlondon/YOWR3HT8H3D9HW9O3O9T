import { normalizeRelationship, REL_DEFAULT } from './relationshipMap.js';

export type RelType = string;

export interface RelEdge {
  token: string;
  rel: RelType;
  weight: number;
}

export interface AdjacencyResult {
  token: string;
  definition?: string;
  neighbors: RelEdge[];
  source: 'kb' | 'llm' | 'synthetic';
}

interface MetadataChunk {
  prefix: string;
  href: string;
  token_count?: number;
}

interface AdjacencyOptions {
  allowSynthetic?: boolean;
  llm?: {
    expandAdjacencyTyped?: (token: string) => Promise<{
      definition?: string;
      edges?: Array<{ neighbor?: string; rel?: string; weight?: number }>;
    }>;
    modelName?: string;
  };
  metadataUrl?: string;
  fetchImpl?: typeof fetch;
}

type TokenRecord = {
  token: string;
  definition?: string;
  relationships?: Record<string, Array<{ token?: string; weight?: number }>>;
};

interface MetadataPayload {
  chunk_prefix_length?: number;
  chunks?: MetadataChunk[];
}

const DEFAULT_METADATA_URL = 'remote-db/metadata.json';

const chunkCache = new Map<string, Map<string, TokenRecord>>();
let metadataPromise: Promise<MetadataPayload | null> | null = null;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizeToken = (value: string): string => value.trim();

async function readJsonLocal(path: string): Promise<any | null> {
  try {
    const { readFile } = await import('fs/promises');
    const resolved = path.startsWith('http')
      ? path
      : new URL(path, `file://${process.cwd()}/`).href;
    const content = await readFile(new URL(resolved), 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function loadMetadata(metadataUrl?: string, fetchImpl: typeof fetch = fetch): Promise<MetadataPayload | null> {
  if (!metadataPromise) {
    metadataPromise = (async () => {
      try {
        const res = await fetchImpl(metadataUrl || DEFAULT_METADATA_URL, { cache: 'no-store' } as RequestInit);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as MetadataPayload;
        if (!data || !Array.isArray(data.chunks)) return null;
        return data;
      } catch (err) {
        const fallback = await readJsonLocal(metadataUrl || DEFAULT_METADATA_URL);
        if (fallback && Array.isArray((fallback as any).chunks)) {
          return fallback as MetadataPayload;
        }
        console.warn('Failed to load adjacency metadata', err);
        return null;
      }
    })();
  }
  return metadataPromise;
}

function chunkKeyForToken(token: string, prefixLength: number): string {
  const normalized = normalizeToken(token);
  const prefix = normalized.slice(0, Math.max(1, prefixLength)).toLowerCase();
  return prefix || '_';
}

async function loadChunk(prefix: string, metadata: MetadataPayload, fetchImpl: typeof fetch = fetch): Promise<Map<string, TokenRecord> | null> {
  if (chunkCache.has(prefix)) return chunkCache.get(prefix)!;
  const chunkEntry = metadata.chunks?.find((c) => c.prefix === prefix);
  if (!chunkEntry || !chunkEntry.href) return null;
  try {
    const res = await fetchImpl(chunkEntry.href, { cache: 'no-store' } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { tokens?: TokenRecord[] };
    const map = new Map<string, TokenRecord>();
    for (const record of data.tokens || []) {
      if (!record || typeof record.token !== 'string') continue;
      map.set(record.token.toLowerCase(), record);
    }
    chunkCache.set(prefix, map);
    return map;
  } catch (err) {
    const fallback = await readJsonLocal(chunkEntry.href);
    if (fallback && Array.isArray((fallback as any).tokens)) {
      const map = new Map<string, TokenRecord>();
      for (const record of (fallback as any).tokens as TokenRecord[]) {
        if (!record || typeof record.token !== 'string') continue;
        map.set(record.token.toLowerCase(), record);
      }
      chunkCache.set(prefix, map);
      return map;
    }
    console.warn('Failed to load adjacency chunk', prefix, err);
    return null;
  }
}

async function adjacencyFromKB(token: string, opts: AdjacencyOptions): Promise<AdjacencyResult | null> {
  const metadata = await loadMetadata(opts.metadataUrl, opts.fetchImpl);
  if (!metadata || !metadata.chunks?.length) return null;
  const prefixLength = Math.max(1, Number(metadata.chunk_prefix_length) || 1);
  const chunkKey = chunkKeyForToken(token, prefixLength);
  const chunk = await loadChunk(chunkKey, metadata, opts.fetchImpl);
  if (!chunk || !chunk.size) return null;
  const record = chunk.get(token.toLowerCase());
  if (!record || !record.relationships || typeof record.relationships !== 'object') return null;

  const neighbors: RelEdge[] = [];
  for (const [relRaw, entries] of Object.entries(record.relationships)) {
    if (!Array.isArray(entries)) continue;
    const rel = normalizeRelationship(relRaw || REL_DEFAULT);
    for (const entry of entries) {
      if (!entry || typeof entry.token !== 'string') continue;
      const weight = clamp01(Number(entry.weight) || 0);
      neighbors.push({ token: entry.token, rel, weight });
    }
  }

  return {
    token,
    definition: record.definition,
    neighbors,
    source: 'kb',
  };
}

async function adjacencyFromLLM(token: string, opts: AdjacencyOptions): Promise<AdjacencyResult | null> {
  if (!opts.llm?.expandAdjacencyTyped) return null;
  try {
    const payload = await opts.llm.expandAdjacencyTyped(token);
    const edges = Array.isArray(payload?.edges) ? payload.edges : [];
    const neighbors: RelEdge[] = edges
      .map((edge) => ({
        token: normalizeToken(edge.neighbor || ''),
        rel: normalizeRelationship(edge.rel || REL_DEFAULT),
        weight: clamp01(Number(edge.weight) || 0.5),
      }))
      .filter((edge) => Boolean(edge.token));
    return { token, definition: payload?.definition, neighbors, source: 'llm' };
  } catch (err) {
    console.warn('LLM adjacency expansion failed', err);
    return null;
  }
}

function syntheticAdjacency(token: string): AdjacencyResult {
  const base = normalizeToken(token) || 'seed';
  const neighbors: RelEdge[] = [
    { token: `[synthetic] ${base} context`, rel: 'synthetic', weight: 0.52 },
    { token: `[synthetic] ${base} analogy`, rel: 'synthetic', weight: 0.44 },
    { token: `[synthetic] ${base} related`, rel: 'synthetic', weight: 0.4 },
  ];
  return {
    token,
    neighbors,
    source: 'synthetic',
  };
}

export async function getAdjacency(token: string, opts: AdjacencyOptions = {}): Promise<AdjacencyResult> {
  const normalized = normalizeToken(token);
  if (!normalized) {
    throw new Error('Token is required for adjacency expansion');
  }

  const kbAdj = await adjacencyFromKB(normalized, opts);
  if (kbAdj && kbAdj.neighbors.length > 0) return kbAdj;

  const llmAdj = await adjacencyFromLLM(normalized, opts);
  if (llmAdj && llmAdj.neighbors.length > 0) return llmAdj;

  if (opts.allowSynthetic) return syntheticAdjacency(normalized);

  throw new Error('No adjacency source available (KB/LLM).');
}
