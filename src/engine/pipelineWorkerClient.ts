import { runPipeline, type PipelineResult } from './pipeline';
import type { Settings } from '../settings';
import { VectorSemanticStore, type EmbeddingSummary } from './vectorSemantics';

interface WorkerRequest {
  id: number;
  type: 'runPipeline';
  text: string;
  settings: Settings;
}

interface WorkerResponse {
  id: number;
  type: 'runPipeline';
  result?: PipelineResult;
  embeddings?: EmbeddingSummary;
  error?: string;
}

export class PipelineWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, { resolve: (value: PipelineResult) => void; reject: (reason: Error) => void }>();
  private readonly embeddingStore: VectorSemanticStore;
  private sequence = 0;
  private fallback = false;

  constructor(options: { embeddingStore?: VectorSemanticStore } = {}) {
    this.embeddingStore = options.embeddingStore ?? new VectorSemanticStore();
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./pipelineWorker.ts', import.meta.url), { type: 'module' });
        this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => this.handleMessage(event));
        this.worker.addEventListener('error', (event) => {
          console.error('Pipeline worker error:', event.message);
          this.teardownWorker();
        });
      } catch (error) {
        console.warn('Falling back to inline pipeline execution:', error);
        this.worker = null;
        this.fallback = true;
      }
    } else {
      this.fallback = true;
    }
  }

  getEmbeddings(): VectorSemanticStore {
    return this.embeddingStore;
  }

  async run(text: string, settings: Settings): Promise<PipelineResult> {
    if (!text || this.fallback || !this.worker) {
      const result = runPipeline(text, settings);
      this.embeddingStore.update({ embeddings: [], globalMetrics: { symbolDensity: result.metrics.symbolDensity, averageWeight: 0 } });
      return result;
    }

    const id = ++this.sequence;

    return new Promise<PipelineResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: WorkerRequest = { id, type: 'runPipeline', text, settings };
      try {
        this.worker!.postMessage(message);
      } catch (error) {
        this.pending.delete(id);
        this.fallback = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  terminate(): void {
    this.teardownWorker();
  }

  private handleMessage(event: MessageEvent<WorkerResponse>): void {
    const data = event.data;
    if (!data || data.type !== 'runPipeline') return;
    const entry = this.pending.get(data.id);
    if (!entry) return;
    this.pending.delete(data.id);

    if (data.error) {
      entry.reject(new Error(data.error));
      return;
    }

    if (data.embeddings) {
      this.embeddingStore.update(data.embeddings);
    }

    if (!data.result) {
      entry.reject(new Error('Pipeline worker returned no result'));
      return;
    }

    entry.resolve(data.result);
  }

  private teardownWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.fallback = true;
    for (const [id, entry] of this.pending.entries()) {
      entry.reject(new Error('Pipeline worker terminated'));
      this.pending.delete(id);
    }
  }
}
