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

interface RemoteDbWriter {
  isSupported(): boolean;
  hasDirectory(): boolean;
  chooseDirectory(): Promise<boolean>;
  handlePersist(update: RemoteDbUpdate | null): void;
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

async function pruneMissingChunks(directory: any, keep: Set<string>) {
  if (!directory) return;
  try {
    for await (const [name, handle] of (directory as any).entries() as AsyncIterable<[string, any]>) {
      if ((handle as any).kind === 'file' && !keep.has(name)) {
        try {
          await directory.removeEntry(name);
        } catch (err: any) {
          if (!err || (err.name !== 'NotFoundError' && err.name !== 'NotAllowedError')) {
            throw err;
          }
        }
      }
    }
  } catch (err: any) {
    if (err && err.name === 'TypeError') {
      // Some browsers do not yet support async iteration on directory handles.
      // Ignore and skip pruning in that case.
      return;
    }
    throw err;
  }
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

  const writeUpdate = async (update: RemoteDbUpdate) => {
    if (!state.directoryHandle) throw new Error('No remote DB directory selected');
    const directory = state.directoryHandle;
    const chunksDirectory = await ensureChunksDirectory();
    if (!chunksDirectory) throw new Error('Unable to access chunks directory');

    const metadata = { ...(update.metadata || {}) };
    if ('token_index' in metadata) {
      delete (metadata as any).token_index;
    }

    logger.onSyncStart?.();

    await writeJsonFile(directory, 'metadata.json', metadata);
    await writeJsonFile(directory, 'token-index.json', Array.isArray(update.tokenIndex) ? update.tokenIndex : []);

    const keep = new Set<string>();
    for (const chunk of update.chunks || []) {
      if (!chunk || !chunk.prefix) continue;
      const payload = {
        prefix: chunk.prefix,
        token_count: Number.isFinite(chunk.token_count)
          ? chunk.token_count
          : Array.isArray(chunk.tokens) ? chunk.tokens.length : 0,
        tokens: Array.isArray(chunk.tokens) ? chunk.tokens : [],
      };
      const fileName = `${chunk.prefix}.json`;
      keep.add(fileName);
      const fileHandle = await chunksDirectory.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writeJsonToWritable(writable, payload);
      } finally {
        await writable.close();
      }
    }

    await pruneMissingChunks(chunksDirectory, keep);
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
  };
}

export type { RemoteDbWriter };
