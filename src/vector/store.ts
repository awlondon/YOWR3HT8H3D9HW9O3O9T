import { dequantize8, quantize8 } from './quant';
import type { Embedding, TokenId, VectorConfig } from './types';

type StoredEmbeddingRecord = {
  key: string;
  tokenId: TokenId;
  provider: string;
  dim: number;
  updatedAt: number;
  buffer: ArrayBuffer;
  quantized?: boolean;
  scale?: number;
  zero?: number;
};

const DB_NAME = 'hlsf_kb';
const STORE_NAME = 'embeddings';
const DB_VERSION = 2;

function normalizeVector(input: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < input.length; i += 1) {
    const v = input[i];
    sumSquares += v * v;
  }
  if (!sumSquares) {
    return input.slice();
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) {
    return input.slice();
  }
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i] / norm;
  }
  return out;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], mode);
    const store = tx.objectStore(STORE_NAME);
    let result: T;
    fn(store)
      .then(value => {
        result = value;
      })
      .catch(error => {
        reject(error);
        tx.abort();
      });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('Vector store transaction failed'));
    tx.onabort = () => {
      if (tx.error) {
        reject(tx.error);
      } else {
        reject(new Error('Vector store transaction aborted'));
      }
    };
  });
}

type MemoryRecord = {
  vector: Float32Array;
  updatedAt: number;
};

export interface VectorStore {
  init(cfg: VectorConfig): Promise<void>;
  put(id: TokenId, v: Embedding): Promise<void>;
  get(id: TokenId): Promise<Embedding | null>;
  similar(id: TokenId, topK: number): Promise<Array<{ id: TokenId; score: number }>>;
  similarText?(text: string, topK: number): Promise<Array<{ id: TokenId; score: number }>>;
}

export function createIdbVectorStore(): VectorStore {
  let config: VectorConfig | null = null;
  let db: IDBDatabase | null = null;
  const memory = new Map<TokenId, MemoryRecord>();

  async function ensureDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return null;
    }
    if (db) return db;
    db = await openDatabase();
    return db;
  }

  function makeKey(id: TokenId): string {
    if (!config) throw new Error('Vector store not initialised');
    return `${config.provider}:${config.dim}:${id}`;
  }

  function prepareVector(input: Float32Array): Float32Array {
    const baseline = input instanceof Float32Array ? input : new Float32Array(input);
    if (!config?.normalize) {
      return baseline.slice();
    }
    return normalizeVector(baseline);
  }

  async function readAllMatching(keyPrefix: string): Promise<StoredEmbeddingRecord[]> {
    const instance = await ensureDb();
    if (!instance) {
      return [];
    }
    return await withStore(instance, 'readonly', async store => {
      const out: StoredEmbeddingRecord[] = [];
      await new Promise<void>((resolve, reject) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const record = cursor.value as StoredEmbeddingRecord;
          if (typeof record.key === 'string' && record.key.startsWith(keyPrefix)) {
            out.push(record);
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    });
  }

  async function fetchRecord(id: TokenId): Promise<StoredEmbeddingRecord | null> {
    const instance = await ensureDb();
    if (!instance) {
      return null;
    }
    return await withStore(instance, 'readonly', async store => {
      return await new Promise<StoredEmbeddingRecord | null>((resolve, reject) => {
        const request = store.get(makeKey(id));
        request.onsuccess = () => resolve((request.result as StoredEmbeddingRecord | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
    });
  }

  function cacheVector(id: TokenId, vector: Float32Array): void {
    memory.set(id, { vector: vector.slice(), updatedAt: Date.now() });
  }

  function vectorFromRecord(record: StoredEmbeddingRecord): Float32Array {
    if (record.quantized) {
      const view = new Uint8Array(record.buffer.slice(0));
      return dequantize8(view, record.scale ?? 1, record.zero ?? 0);
    }
    return new Float32Array(record.buffer.slice(0));
  }

  async function writeRecord(id: TokenId, vector: Float32Array): Promise<void> {
    const instance = await ensureDb();
    if (!instance) {
      cacheVector(id, vector);
      return;
    }
    await withStore(instance, 'readwrite', async store => {
      let payload: StoredEmbeddingRecord;
      if (config?.quantize8) {
        const { q, scale, zero } = quantize8(vector);
        payload = {
          key: makeKey(id),
          tokenId: id,
          provider: config.provider,
          dim: config.dim,
          updatedAt: Date.now(),
          buffer: q.buffer.slice(0),
          quantized: true,
          scale,
          zero,
        };
      } else {
        payload = {
          key: makeKey(id),
          tokenId: id,
          provider: config?.provider ?? 'unknown',
          dim: config?.dim ?? vector.length,
          updatedAt: Date.now(),
          buffer: vector.buffer.slice(0),
        };
      }
      await new Promise<void>((resolve, reject) => {
        const request = store.put(payload);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      return payload;
    });
  }

  return {
    async init(cfg: VectorConfig) {
      config = cfg;
      memory.clear();
      if (typeof indexedDB !== 'undefined') {
        db = await openDatabase();
      } else {
        db = null;
      }
    },

    async put(id: TokenId, v: Embedding) {
      if (!config) throw new Error('Vector store not initialised');
      const vector = prepareVector(v);
      cacheVector(id, vector);
      await writeRecord(id, vector);
    },

    async get(id: TokenId): Promise<Embedding | null> {
      const cached = memory.get(id);
      if (cached) {
        return cached.vector.slice();
      }
      const record = await fetchRecord(id);
      if (!record) return null;
      const vector = vectorFromRecord(record);
      cacheVector(id, vector);
      return vector;
    },

    async similar(id: TokenId, topK: number): Promise<Array<{ id: TokenId; score: number }>> {
      const origin = await this.get(id);
      if (!origin) return [];
      if (!config) return [];
      const keyPrefix = `${config.provider}:${config.dim}:`;
      const records = await readAllMatching(keyPrefix);
      const results: Array<{ id: TokenId; score: number }> = [];
      const visited = new Set<TokenId>();

      const pushCandidate = (candidateId: TokenId, candidate: Float32Array) => {
        if (candidateId === id) return;
        if (visited.has(candidateId)) return;
        if (candidate.length !== origin.length) return;
        let dot = 0;
        let normB = 0;
        for (let i = 0; i < candidate.length; i += 1) {
          const a = origin[i];
          const b = candidate[i];
          dot += a * b;
          normB += b * b;
        }
        if (!normB) return;
        const score = dot / Math.sqrt(normB);
        if (!Number.isFinite(score)) return;
        visited.add(candidateId);
        results.push({ id: candidateId, score });
      };

      for (const record of records) {
        if (record.tokenId === id) continue;
        const vector = vectorFromRecord(record);
        cacheVector(record.tokenId, vector);
        pushCandidate(record.tokenId, vector);
      }

      for (const [candidateId, memo] of memory.entries()) {
        if (candidateId === id) continue;
        pushCandidate(candidateId, memo.vector);
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, Math.max(0, topK));
    },
  } satisfies VectorStore;
}
