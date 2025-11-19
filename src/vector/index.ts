import { createIdbVectorStore, type VectorStore } from './store';
import { hybridExpand } from './hybrid';
import type { HybridExpandOptions, SimilarResult, TokenId, VectorConfig } from './types';
import { registerTokenObserver, registerGraphObserver } from './globals';
import { OnnxEncoder } from './providers/onnx-encoder';
import { Word2VecOnline } from './providers/word2vec-online';
import { ApiEncoder } from './providers/api-encoder';
import type { EmbeddingProvider } from './providers/provider-types';
import type { KBStore } from '../kb';

export const DEFAULT_VECTOR_CONFIG: VectorConfig = {
  provider: 'onnx',
  dim: 384,
  device: 'wasm',
  quantize8: true,
  normalize: true,
  batchSize: 64,
  index: { type: 'flat' },
};

let cfg: VectorConfig | null = null;
let worker: Worker | null = null;
const store: VectorStore = createIdbVectorStore();
let seq = 0;
const inflight = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
let inlineProvider: EmbeddingProvider | null = null;
let kbRef: KBStore | null = null;

const queue = new Map<TokenId, string>();
let flushScheduled = false;
let telemetry = {
  batches: 0,
  lastBatchDurationMs: 0,
};

const now = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

function pickProvider(name: VectorConfig['provider']): EmbeddingProvider {
  switch (name) {
    case 'onnx':
      return new OnnxEncoder();
    case 'word2vec':
      return new Word2VecOnline();
    case 'api':
      return new ApiEncoder();
    default:
      throw new Error(`Unsupported vector provider: ${name}`);
  }
}

function ensureInitialized(): void {
  if (!cfg) {
    throw new Error('Vector subsystem not initialised');
  }
}

  async function callWorker<T>(op: 'init' | 'embed' | 'train', payload: any): Promise<T> {
    const activeWorker = worker;
    if (!activeWorker) {
      throw new Error('Vector worker unavailable');
    }
    return await new Promise<T>((resolve, reject) => {
      const id = ++seq;
      inflight.set(id, { resolve, reject });
      activeWorker.postMessage({ id, op, payload });
    });
  }

async function embedTokens(tokens: string[]): Promise<Float32Array[]> {
  ensureInitialized();
  if (worker) {
    const response = await callWorker<{ vecs: ArrayBuffer[] }>('embed', { tokens });
    const buffers = response?.vecs ?? [];
    return buffers.map((buf: ArrayBuffer) => new Float32Array(buf));
  }
  if (!inlineProvider) {
    throw new Error('Vector provider unavailable');
  }
  return inlineProvider.embedTokens(tokens);
}

async function flushQueue(): Promise<void> {
  flushScheduled = false;
  if (!cfg || queue.size === 0) {
    return;
  }
  const batchSize = Math.max(1, cfg.batchSize ?? 32);
  const start = now();
  try {
    while (queue.size > 0) {
      const entries = Array.from(queue.entries()).slice(0, batchSize);
      if (!entries.length) break;
      const texts = entries.map(([, text]) => text);
      const ids = entries.map(([id]) => id);
      const vectors = await embedTokens(texts);
      await Promise.all(
        vectors.map((vec, index) => store.put(ids[index], vec)),
      );
      for (const id of ids) {
        queue.delete(id);
      }
      telemetry.batches += 1;
    }
  } catch (error) {
    console.warn('Vector queue flush failed, re-queueing', error);
  } finally {
    telemetry.lastBatchDurationMs = now() - start;
    if (queue.size > 0) {
      scheduleFlush();
    }
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const idle = (globalThis as any).requestIdleCallback as ((cb: () => void) => number) | undefined;
  if (typeof idle === 'function') {
    idle(() => {
      void flushQueue();
    });
  } else {
    setTimeout(() => {
      void flushQueue();
    }, 20);
  }
}

function handleTokenObserved(payload: { id: number; text: string }): void {
  if (!cfg) return;
  if (!payload.text) return;
  queue.set(payload.id, payload.text);
  scheduleFlush();
}

function handleGraphUpdated(): void {
  // Reserved for future ANN maintenance.
}

function configureWorkerListeners(instance: Worker): void {
  instance.onmessage = event => {
    const { id, ok, result, error } = event.data ?? {};
    const pending = inflight.get(id);
    if (!pending) return;
    inflight.delete(id);
    if (ok) {
      pending.resolve(result as any);
    } else {
      pending.reject(new Error(error ?? 'Vector worker error'));
    }
  };
  instance.onerror = event => {
    console.error('Vector worker error', event);
  };
}

export async function initVector(config: VectorConfig, opts: { kb?: KBStore } = {}): Promise<void> {
  cfg = { ...config };
  kbRef = opts.kb ?? kbRef ?? null;
  telemetry = { batches: 0, lastBatchDurationMs: 0 };
  await store.init(cfg);

  if (typeof Worker !== 'undefined') {
    worker = new Worker(new URL('./index.worker.ts', import.meta.url), { type: 'module' });
    configureWorkerListeners(worker);
    await callWorker('init', { cfg });
    inlineProvider = null;
  } else {
    worker = null;
    inlineProvider = pickProvider(cfg.provider);
    await inlineProvider.init(cfg);
  }

  registerTokenObserver(handleTokenObserved);
  registerGraphObserver(() => handleGraphUpdated());
}

export function attachKnowledgeBase(kb: KBStore): void {
  kbRef = kb;
}

export async function embedAndStore(tokenId: TokenId, tokenText: string): Promise<Float32Array> {
  ensureInitialized();
  const vectors = await embedTokens([tokenText]);
  const vector = vectors[0];
  await store.put(tokenId, vector);
  return vector;
}

export async function ensureEmbedding(tokenId: TokenId, tokenText: string): Promise<Float32Array> {
  const existing = await store.get(tokenId);
  if (existing) return existing;
  return embedAndStore(tokenId, tokenText);
}

export async function similar(tokenId: TokenId, topK = 10): Promise<SimilarResult[]> {
  ensureInitialized();
  return await store.similar(tokenId, topK);
}

export async function hybrid(options: HybridExpandOptions): Promise<SimilarResult[]> {
  ensureInitialized();
  return await hybridExpand(options, {
    store: {
      get: id => store.get(id),
      similar: (id, k) => store.similar(id, k),
    },
    kb: kbRef ?? undefined,
  });
}

export async function trainPairs(pairs: Array<[string, string]>, epochs = 1): Promise<void> {
  ensureInitialized();
  if (worker) {
    await callWorker('train', { pairs, epochs });
    return;
  }
  if (inlineProvider?.trainPairs) {
    await inlineProvider.trainPairs(pairs, epochs);
  }
}

export function observeToken(id: TokenId, text: string): void {
  handleTokenObserved({ id, text });
}

export function status(): {
  configured: boolean;
  provider?: string;
  dim?: number;
  queueSize: number;
  worker: boolean;
  telemetry: { batches: number; lastBatchMs: number };
} {
  return {
    configured: Boolean(cfg),
    provider: cfg?.provider,
    dim: cfg?.dim,
    queueSize: queue.size,
    worker: Boolean(worker),
    telemetry: { batches: telemetry.batches, lastBatchMs: telemetry.lastBatchDurationMs },
  };
}

export async function shutdownVector(): Promise<void> {
  registerTokenObserver(null);
  registerGraphObserver(null);
  if (worker) {
    worker.terminate();
    worker = null;
  }
  inlineProvider = null;
  cfg = null;
  queue.clear();
  inflight.clear();
  telemetry = { batches: 0, lastBatchDurationMs: 0 };
}
