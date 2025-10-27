const MAX_SUCCESS_LOG_INTERVAL_MS = 1500;

interface RemoteDbUpdate {
  metadata: any;
  chunks: Array<{ prefix: string; token_count: number; tokens: any[] }> | null;
  tokenIndex?: string[];
}

interface RemoteDbWriterLogger {
  onMissingDirectory?: (reason?: 'unsupported' | 'permission') => void;
  onSyncStart?: () => void;
  onSyncSuccess?: (info: { chunkCount: number }) => void;
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

async function writeJsonFile(directory: any, name: string, data: unknown) {
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
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
    pendingUpdate: RemoteDbUpdate | null;
    writing: boolean;
    lastSuccessAt: number;
    missingNotified: boolean;
  } = {
    directoryHandle: null,
    chunksHandle: null,
    pendingUpdate: null,
    writing: false,
    lastSuccessAt: 0,
    missingNotified: false,
  };

  const ensureDirectory = async () => {
    if (!state.directoryHandle) return false;
    try {
      await (state.directoryHandle as any).requestPermission?.({ mode: 'readwrite' });
    } catch {
      // ignore
    }
    return true;
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
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();
    }

    await pruneMissingChunks(chunksDirectory, keep);
  };

  const processQueue = async () => {
    if (!state.pendingUpdate || state.writing) return;

    if (!supported) {
      if (!state.missingNotified) {
        state.missingNotified = true;
        logger.onMissingDirectory?.('unsupported');
      }
      state.pendingUpdate = null;
      return;
    }

    if (!state.directoryHandle) {
      if (!state.missingNotified) {
        state.missingNotified = true;
        logger.onMissingDirectory?.();
      }
      return;
    }

    if (!(await ensureDirectory())) {
      if (!state.missingNotified) {
        state.missingNotified = true;
        logger.onMissingDirectory?.('permission');
      }
      return;
    }

    const update = normalizeUpdate(state.pendingUpdate);
    state.pendingUpdate = null;
    state.writing = true;
    try {
      await writeUpdate(update);
      state.missingNotified = false;
      const now = Date.now();
      if (now - state.lastSuccessAt > MAX_SUCCESS_LOG_INTERVAL_MS) {
        logger.onSyncSuccess?.({ chunkCount: update.chunks ? update.chunks.length : 0 });
        state.lastSuccessAt = now;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.onSyncError?.(`Remote DB sync failed: ${message}`);
      state.pendingUpdate = state.pendingUpdate || update;
    } finally {
      state.writing = false;
      if (state.pendingUpdate) {
        setTimeout(() => { processQueue().catch(() => {}); }, 200);
      }
    }
  };

  const handlePersist = (update: RemoteDbUpdate | null) => {
    state.pendingUpdate = update;
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
      if (state.pendingUpdate) {
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
