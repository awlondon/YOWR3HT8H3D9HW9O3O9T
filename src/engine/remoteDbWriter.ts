const MAX_SUCCESS_LOG_INTERVAL_MS = 1500;
const DEFAULT_AVERAGE_WORK_MS = 250;

interface RemoteDbSyncProgress {
  queueLength: number;
  pendingWorkUnits: number;
  pendingChunks: number;
  averageMsPerUnit: number;
  activeStart: number | null;
  activeWorkUnits: number;
}

interface RemoteDbSyncSuccessInfo {
  chunkCount: number;
  durationMs: number;
}

interface RemoteDbUpdate {
  metadata: any;
  chunks: Array<{ prefix: string; token_count: number; tokens: any[] }> | null;
  tokenIndex?: string[];
}

interface RemoteDbWriterLogger {
  onMissingDirectory?: (reason?: 'unsupported' | 'permission') => void;
  onSyncStart?: (info: RemoteDbSyncProgress) => void;
  onSyncProgress?: (info: RemoteDbSyncProgress) => void;
  onSyncSuccess?: (info: RemoteDbSyncSuccessInfo) => void;
  onSyncIdle?: (info: RemoteDbSyncSuccessInfo) => void;
  onSyncError?: (message: string) => void;
}

interface RemoteDbDirectoryStats {
  connected: boolean;
  metadata: any | null;
  totalTokens: number | null;
  totalRelationships: number | null;
  tokenIndexCount: number | null;
  chunkCount: number;
  chunkPrefixLength: number | null;
  generatedAt: string | null;
  largestChunk: { prefix: string; count: number } | null;
  smallestChunk: { prefix: string; count: number } | null;
  error?: string;
}

interface RemoteDbWriter {
  isSupported(): boolean;
  hasDirectory(): boolean;
  chooseDirectory(): Promise<boolean>;
  handlePersist(update: RemoteDbUpdate | null): void;
  getDirectoryStats(): Promise<RemoteDbDirectoryStats>;
}

function isFsSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';
}

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now()
  : Date.now());

function cloneData<T>(data: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data)) as T;
}

async function writeJsonToWritable(writable: any, data: unknown) {
  const serialized = JSON.stringify(cloneData(data));
  if (encoder) {
    await writable.write(encoder.encode(serialized));
  } else {
    await writable.write(serialized);
  }
}

async function writeJsonFile(directory: any, name: string, data: unknown) {
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writeJsonToWritable(writable, data);
  } finally {
    await writable.close();
  }
}

async function readJsonFromHandle(handle: any) {
  if (!handle || typeof handle.getFile !== 'function') return null;
  try {
    const file = await handle.getFile();
    if (!file || typeof file.text !== 'function') return null;
    const text = await file.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (err: any) {
    if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
      return null;
    }
    throw err;
  }
}

async function readJsonFileFromDirectory(directory: any, name: string) {
  if (!directory || typeof directory.getFileHandle !== 'function') return null;
  try {
    const fileHandle = await directory.getFileHandle(name);
    return await readJsonFromHandle(fileHandle);
  } catch (err: any) {
    if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
      return null;
    }
    throw err;
  }
}

function parseTokenIndexPayload(payload: any): string[] {
  if (!payload) return [];
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.tokens)
      ? payload.tokens
      : [];
  return list
    .map(token => (typeof token === 'string' ? token.trim() : ''))
    .filter(Boolean);
}

function mergeChunkTokens(existing: any[], incoming: any[]) {
  const order: string[] = [];
  const map = new Map<string, any>();

  const addRecords = (records: any[], preferNew: boolean) => {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const rawToken = typeof record.token === 'string' ? record.token : '';
      const token = rawToken.trim();
      if (!token) continue;
      const key = token.toLowerCase();
      if (!map.has(key)) {
        order.push(key);
        map.set(key, cloneData(record));
      } else if (preferNew) {
        map.set(key, cloneData(record));
      }
    }
  };

  addRecords(existing, false);
  addRecords(incoming, true);

  return order
    .map(key => map.get(key))
    .filter((entry): entry is any => Boolean(entry));
}

function countRelationships(record: any): number {
  if (!record || typeof record !== 'object') return 0;
  const relationships = (record as any).relationships;
  if (!relationships || typeof relationships !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(relationships)) {
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

export function createRemoteDbFileWriter(logger: RemoteDbWriterLogger = {}): RemoteDbWriter {
  if (typeof window === 'undefined') {
    return {
      isSupported: () => false,
      hasDirectory: () => false,
      async chooseDirectory() { return false; },
      handlePersist: () => {},
    };
  }

  const supported = isFsSupported();
  const state: {
    directoryHandle: any;
    chunksHandle: any;
    pendingUpdates: RemoteDbUpdate[];
    writing: boolean;
    lastSuccessAt: number;
    missingNotified: boolean;
    flushRequested: boolean;
    metrics: {
      totalDurationMs: number;
      totalWorkUnits: number;
      activeStart: number;
      activeWorkUnits: number;
      lastChunkCount: number;
      lastDurationMs: number;
    };
    wasIdleNotified: boolean;
  } = {
    directoryHandle: null,
    chunksHandle: null,
    pendingUpdates: [],
    writing: false,
    lastSuccessAt: 0,
    missingNotified: false,
    flushRequested: false,
    metrics: {
      totalDurationMs: 0,
      totalWorkUnits: 0,
      activeStart: 0,
      activeWorkUnits: 0,
      lastChunkCount: 0,
      lastDurationMs: 0,
    },
    wasIdleNotified: false,
  };

  const computeChunkCount = (update: RemoteDbUpdate | null) => {
    if (!update) return 0;
    const chunks = Array.isArray(update.chunks) ? update.chunks : [];
    return chunks.length;
  };

  const computeWorkUnits = (update: RemoteDbUpdate | null) => {
    const chunkCount = computeChunkCount(update);
    return Math.max(1, chunkCount + 1);
  };

  const buildProgressInfo = (): RemoteDbSyncProgress => {
    let pendingChunks = 0;
    let pendingWorkUnits = 0;
    for (const update of state.pendingUpdates) {
      pendingChunks += computeChunkCount(update);
      pendingWorkUnits += computeWorkUnits(update);
    }

    const derivedAverage = state.metrics.totalWorkUnits > 0
      ? state.metrics.totalDurationMs / state.metrics.totalWorkUnits
      : (pendingWorkUnits > 0 ? DEFAULT_AVERAGE_WORK_MS : 0);

    return {
      queueLength: state.pendingUpdates.length,
      pendingWorkUnits,
      pendingChunks,
      averageMsPerUnit: derivedAverage,
      activeStart: state.writing ? state.metrics.activeStart : null,
      activeWorkUnits: state.writing ? state.metrics.activeWorkUnits : 0,
    };
  };

  const notifyProgress = () => {
    const info = buildProgressInfo();
    logger.onSyncProgress?.(info);

    if (info.queueLength === 0 && !state.writing) {
      if (!state.wasIdleNotified) {
        state.wasIdleNotified = true;
        logger.onSyncIdle?.({
          chunkCount: state.metrics.lastChunkCount,
          durationMs: state.metrics.lastDurationMs,
        });
      }
    } else {
      state.wasIdleNotified = false;
    }
  };

  const ensureDirectory = async () => {
    if (!state.directoryHandle) return false;
    const handle = state.directoryHandle as any;
    const ensurePermissionGranted = async () => {
      const requestPermission = handle.requestPermission?.bind(handle);
      let status: string | undefined;
      if (requestPermission) {
        status = await requestPermission({ mode: 'readwrite' });
        if (status && status !== 'granted') {
          return false;
        }
      }

      if (!status && typeof handle.queryPermission === 'function') {
        const queryStatus = await handle.queryPermission({ mode: 'readwrite' });
        if (queryStatus && queryStatus !== 'granted') {
          return false;
        }
      }

      return true;
    };

    try {
      return await ensurePermissionGranted();
    } catch (err: any) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        return false;
      }
      throw err;
    }
  };

  const ensureChunksDirectory = async () => {
    if (!state.directoryHandle) return null;
    if (state.chunksHandle) return state.chunksHandle;
    state.chunksHandle = await state.directoryHandle.getDirectoryHandle('chunks', { create: true });
    return state.chunksHandle;
  };

  const normalizeUpdate = (update: RemoteDbUpdate | null) => {
    if (!update || !update.metadata) {
      return {
        metadata: {
          version: '2.1',
          generated_at: new Date().toISOString(),
          source: 'session-cache',
          total_tokens: 0,
          total_relationships: 0,
          chunk_prefix_length: 1,
          chunks: [],
          token_index_href: 'token-index.json',
        },
        chunks: [],
        tokenIndex: [],
      } as RemoteDbUpdate;
    }
    const chunks = Array.isArray(update.chunks) ? update.chunks : [];
    const tokenIndex = Array.isArray(update.tokenIndex) ? update.tokenIndex : (update as any).token_index || [];
    return {
      metadata: update.metadata,
      chunks,
      tokenIndex,
    } as RemoteDbUpdate;
  };

  const getDirectoryStats = async (): Promise<RemoteDbDirectoryStats> => {
    const base: RemoteDbDirectoryStats = {
      connected: false,
      metadata: null,
      totalTokens: null,
      totalRelationships: null,
      tokenIndexCount: null,
      chunkCount: 0,
      chunkPrefixLength: null,
      generatedAt: null,
      largestChunk: null,
      smallestChunk: null,
    };

    if (!state.directoryHandle) {
      return { ...base, error: 'No directory connected' };
    }

    let hasAccess = false;
    try {
      hasAccess = await ensureDirectory();
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, error: message || 'Unable to verify directory access' };
    }

    if (!hasAccess) {
      return { ...base, error: 'Directory permission not granted' };
    }

    try {
      const metadata = await readJsonFileFromDirectory(state.directoryHandle, 'metadata.json');
      const tokenIndexPayload = await readJsonFileFromDirectory(state.directoryHandle, 'token-index.json');
      const tokenIndexList = parseTokenIndexPayload(tokenIndexPayload);

      const chunks = Array.isArray(metadata?.chunks) ? metadata.chunks : [];
      let totalTokens = 0;
      let hasTokenTotal = false;
      let largestChunk: { prefix: string; count: number } | null = null;
      let smallestChunk: { prefix: string; count: number } | null = null;

      for (const chunk of chunks) {
        if (!chunk || typeof chunk !== 'object') continue;
        const prefix = typeof (chunk as any).prefix === 'string' && (chunk as any).prefix
          ? (chunk as any).prefix
          : '_';
        const countRaw = Number((chunk as any).token_count);
        if (!Number.isFinite(countRaw)) continue;
        const count = Math.max(0, Math.floor(countRaw));
        totalTokens += count;
        hasTokenTotal = true;
        if (!largestChunk || count > largestChunk.count) {
          largestChunk = { prefix, count };
        }
        if (!smallestChunk || count < smallestChunk.count) {
          smallestChunk = { prefix, count };
        }
      }

      const relationshipRaw = (metadata as any)?.total_relationships ?? (metadata as any)?.totalRelationships;
      const totalRelationships = Number.isFinite(relationshipRaw)
        ? Math.max(0, Math.floor(relationshipRaw))
        : null;

      const chunkPrefixLengthRaw = (metadata as any)?.chunk_prefix_length ?? (metadata as any)?.chunkPrefixLength;
      const chunkPrefixLength = Number.isFinite(chunkPrefixLengthRaw)
        ? Math.max(1, Math.floor(chunkPrefixLengthRaw))
        : null;

      const generatedAt = (metadata as any)?.generated_at
        || (metadata as any)?.generatedAt
        || (metadata as any)?.generated
        || null;

      return {
        connected: true,
        metadata: metadata ?? null,
        totalTokens: hasTokenTotal ? totalTokens : null,
        totalRelationships,
        tokenIndexCount: tokenIndexList.length ? tokenIndexList.length : null,
        chunkCount: chunks.length,
        chunkPrefixLength,
        generatedAt,
        largestChunk,
        smallestChunk,
      };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        connected: true,
        error: message || 'Failed to read remote DB directory',
      };
    }
  };

  const writeUpdate = async (update: RemoteDbUpdate) => {
    if (!state.directoryHandle) throw new Error('No remote DB directory selected');
    const directory = state.directoryHandle;
    const chunksDirectory = await ensureChunksDirectory();
    if (!chunksDirectory) throw new Error('Unable to access chunks directory');

    const metadata = { ...(update.metadata || {}) };
    if ('token_index' in metadata) {
      delete (metadata as any).token_index;
    }

    const existingMetadata = await readJsonFileFromDirectory(directory, 'metadata.json');
    const existingTokenIndex = parseTokenIndexPayload(
      await readJsonFileFromDirectory(directory, 'token-index.json'),
    );

    const parsePrefix = (raw: unknown): { key: string; label: string } => {
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed) {
          return { key: trimmed.toLowerCase(), label: trimmed };
        }
      }
      return { key: '_', label: '_' };
    };

    type ChunkEntryInfo = { prefix: string; href: string; token_count: number };
    const chunkEntries = new Map<string, ChunkEntryInfo>();
    const existingChunkInfo = new Map<string, { prefix: string; href: string }>();
    const incomingChunkInfo = new Map<string, { prefix: string; href: string }>();

    const registerChunkMetadata = (
      target: Map<string, { prefix: string; href: string }>,
      raw: any,
    ) => {
      if (!raw || typeof raw !== 'object') return;
      const { key, label } = parsePrefix((raw as any).prefix);
      const hrefValue = typeof raw.href === 'string' && raw.href.trim()
        ? raw.href.trim()
        : `chunks/${label}.json`;
      target.set(key, { prefix: label, href: hrefValue });
      const existing = chunkEntries.get(key);
      const tokenCount = Number.isFinite(raw.token_count)
        ? Number(raw.token_count)
        : existing?.token_count ?? 0;
      chunkEntries.set(key, {
        prefix: label,
        href: hrefValue || existing?.href || `chunks/${label}.json`,
        token_count: tokenCount,
      });
    };

    if (Array.isArray(existingMetadata?.chunks)) {
      for (const chunk of existingMetadata.chunks) {
        registerChunkMetadata(existingChunkInfo, chunk);
      }
    }

    if (Array.isArray(metadata?.chunks)) {
      for (const chunk of metadata.chunks) {
        registerChunkMetadata(incomingChunkInfo, chunk);
      }
    }

    const chunkDataCache = new Map<string, { prefix: string; tokens: any[] }>();

    const resolveChunkFileName = (entry: ChunkEntryInfo) => {
      const href = typeof entry.href === 'string' ? entry.href.trim() : '';
      if (href) {
        const parts = href.split(/[\\/]/);
        const last = parts[parts.length - 1];
        if (last) return last;
      }
      const safePrefix = entry.prefix || '_';
      return `${safePrefix}.json`;
    };

    const chunkUpdates = Array.isArray(update.chunks) ? update.chunks : [];
    for (const chunk of chunkUpdates) {
      if (!chunk) continue;
      const { key, label } = parsePrefix(chunk.prefix);
      const metaInfo = incomingChunkInfo.get(key) || existingChunkInfo.get(key) || null;
      const href = metaInfo?.href || `chunks/${metaInfo?.prefix || label}.json`;
      const entryPrefix = metaInfo?.prefix || label;
      const fileName = (() => {
        if (metaInfo?.href) {
          const parts = metaInfo.href.split(/[\\/]/);
          const last = parts[parts.length - 1];
          if (last) return last;
        }
        return `${entryPrefix}.json`;
      })();

      const fileHandle = await chunksDirectory.getFileHandle(fileName, { create: true });
      const existingPayload = await readJsonFromHandle(fileHandle);
      const existingTokens = Array.isArray(existingPayload?.tokens) ? existingPayload.tokens : [];
      const incomingTokens = Array.isArray(chunk.tokens) ? chunk.tokens : [];
      const mergedTokens = mergeChunkTokens(existingTokens, incomingTokens);

      const writable = await fileHandle.createWritable();
      try {
        await writeJsonToWritable(writable, {
          prefix: entryPrefix,
          token_count: mergedTokens.length,
          tokens: mergedTokens,
        });
      } finally {
        await writable.close();
      }

      chunkEntries.set(key, {
        prefix: entryPrefix,
        href,
        token_count: mergedTokens.length,
      });
      chunkDataCache.set(key, { prefix: entryPrefix, tokens: mergedTokens });
    }

    const tokenSet = new Map<string, string>();
    const addTokens = (tokens: string[] | undefined | null, preferNew = false) => {
      if (!Array.isArray(tokens)) return;
      for (const token of tokens) {
        if (typeof token !== 'string') continue;
        const trimmed = token.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (!key) continue;
        if (!tokenSet.has(key) || preferNew) {
          tokenSet.set(key, trimmed);
        }
      }
    };

    addTokens(existingTokenIndex, false);

    const chunkTotals: ChunkEntryInfo[] = [];
    let totalTokens = 0;
    let totalRelationships = 0;

    for (const [key, entry] of chunkEntries.entries()) {
      let cached = chunkDataCache.get(key);
      if (!cached) {
        const fileName = resolveChunkFileName(entry);
        try {
          const fileHandle = await chunksDirectory.getFileHandle(fileName);
          const payload = await readJsonFromHandle(fileHandle);
          const tokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
          cached = { prefix: entry.prefix, tokens };
        } catch (err: any) {
          if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
            cached = { prefix: entry.prefix, tokens: [] };
          } else {
            throw err;
          }
        }
        chunkDataCache.set(key, cached);
      }

      const tokens = Array.isArray(cached?.tokens) ? cached.tokens : [];
      const tokenCount = tokens.length;
      entry.token_count = tokenCount;
      chunkTotals.push({ prefix: entry.prefix, href: entry.href, token_count: tokenCount });
      totalTokens += tokenCount;

      for (const record of tokens) {
        if (record && typeof record.token === 'string') {
          addTokens([record.token], true);
        }
        totalRelationships += countRelationships(record);
      }
    }

    const updateTokenIndex = Array.isArray(update.tokenIndex) ? update.tokenIndex : [];
    addTokens(updateTokenIndex, true);

    const mergedTokenIndex = Array.from(tokenSet.values())
      .filter(token => typeof token === 'string' && token.trim())
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    chunkTotals.sort((a, b) => (a.prefix || '_').localeCompare(b.prefix || '_', undefined, { sensitivity: 'base' }));

    const baseMetadata = existingMetadata && typeof existingMetadata === 'object'
      ? cloneData(existingMetadata)
      : {};
    const incomingMetadata = metadata && typeof metadata === 'object'
      ? cloneData(metadata)
      : {};

    const mergedMetadata = Object.assign(baseMetadata, incomingMetadata, {
      chunks: chunkTotals,
      total_tokens: totalTokens,
      total_relationships: totalRelationships,
    });

    const prefixLengthCandidates = [
      Number((incomingMetadata as any).chunk_prefix_length),
      Number((existingMetadata as any)?.chunk_prefix_length),
    ].filter(value => Number.isFinite(value) && value > 0) as number[];
    mergedMetadata.chunk_prefix_length = prefixLengthCandidates.length
      ? Math.max(1, Math.floor(prefixLengthCandidates[0]))
      : 1;

    if (!mergedMetadata.generated_at) {
      mergedMetadata.generated_at = new Date().toISOString();
    }
    if (!mergedMetadata.token_index_href) {
      mergedMetadata.token_index_href = 'token-index.json';
    }
    if ('token_index' in mergedMetadata) {
      delete (mergedMetadata as any).token_index;
    }

    await writeJsonFile(directory, 'metadata.json', mergedMetadata);
    await writeJsonFile(directory, 'token-index.json', mergedTokenIndex);
  };

  const processQueue = async () => {
    if (state.writing) return;

    const nextUpdate = state.pendingUpdates[0];
    if (!nextUpdate) {
      state.flushRequested = false;
      notifyProgress();
      return;
    }

    if (!supported) {
      if (!state.missingNotified) {
        state.missingNotified = true;
        logger.onMissingDirectory?.('unsupported');
      }
      state.pendingUpdates = [];
      state.flushRequested = false;
      notifyProgress();
      return;
    }

    if (!state.directoryHandle) {
      if (!state.missingNotified) {
        state.missingNotified = true;
        logger.onMissingDirectory?.();
      }
      notifyProgress();
      return;
    }

    if (!(await ensureDirectory())) {
      if (!state.missingNotified) {
        state.missingNotified = true;
        logger.onMissingDirectory?.('permission');
      }
      notifyProgress();
      return;
    }

    const update = normalizeUpdate(nextUpdate);
    state.pendingUpdates[0] = update;
    state.writing = true;
    state.metrics.activeStart = nowMs();
    state.metrics.activeWorkUnits = computeWorkUnits(update);
    state.wasIdleNotified = false;
    const startInfo = buildProgressInfo();
    logger.onSyncStart?.(startInfo);
    logger.onSyncProgress?.(startInfo);
    try {
      await writeUpdate(update);
      state.pendingUpdates.shift();
      state.missingNotified = false;
      const duration = Math.max(0, nowMs() - state.metrics.activeStart);
      const workUnits = Math.max(1, state.metrics.activeWorkUnits || computeWorkUnits(update));
      state.metrics.totalDurationMs += duration;
      state.metrics.totalWorkUnits += workUnits;
      state.metrics.lastChunkCount = Array.isArray(update.chunks) ? update.chunks.length : 0;
      state.metrics.lastDurationMs = duration;
      const now = Date.now();
      const queueEmpty = state.pendingUpdates.length === 0;
      if (queueEmpty || now - state.lastSuccessAt > MAX_SUCCESS_LOG_INTERVAL_MS) {
        logger.onSyncSuccess?.({
          chunkCount: state.metrics.lastChunkCount,
          durationMs: state.metrics.lastDurationMs,
        });
        state.lastSuccessAt = now;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.onSyncError?.(`Remote DB sync failed: ${message}`);
    } finally {
      state.writing = false;
      state.metrics.activeStart = 0;
      state.metrics.activeWorkUnits = 0;
      notifyProgress();
      if (state.pendingUpdates.length || state.flushRequested) {
        setTimeout(() => { processQueue().catch(() => {}); }, 200);
      }
    }
  };

  const handlePersist = (update: RemoteDbUpdate | null) => {
    if (update) {
      state.pendingUpdates.push(update);
    } else {
      state.flushRequested = true;
    }
    state.wasIdleNotified = false;
    notifyProgress();
    processQueue().catch(() => {});
  };

  const chooseDirectory = async () => {
    if (!supported) {
      logger.onMissingDirectory?.('unsupported');
      throw new Error('File System Access API is not available in this browser');
    }
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      state.directoryHandle = handle;
      state.chunksHandle = null;
      state.missingNotified = false;
      await ensureChunksDirectory();
      if (state.pendingUpdates.length) {
        await processQueue();
      }
      return true;
    } catch (err: any) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        logger.onSyncError?.('Remote DB directory selection cancelled.');
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.onSyncError?.(`Failed to select remote DB directory: ${message}`);
      return false;
    }
  };

  return {
    isSupported: () => supported,
    hasDirectory: () => state.directoryHandle != null,
    chooseDirectory,
    handlePersist,
    getDirectoryStats,
  };
}

export type { RemoteDbWriter, RemoteDbDirectoryStats };
