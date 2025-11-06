import type {
  PerfStats,
  PipelineInput,
  PipelineResult,
  TelemetryHook,
  WorkerRequest,
  WorkerResponse,
} from '../types/pipeline-messages.js';

export interface RunOptions {
  telemetry?: TelemetryHook;
  signal?: AbortSignal;
}

interface Listener {
  (message: WorkerResponse): void;
}

export class PipelineWorkerClient {
  private worker: Worker;

  private listeners = new Map<string, Listener>();

  private inflight = new Set<string>();

  constructor() {
    this.worker = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (!msg || !msg.requestId) {
        return;
      }
      const handler = this.listeners.get(msg.requestId);
      if (handler) {
        handler(msg);
      }
    };
  }

  run(
    input: PipelineInput,
    options: RunOptions = {},
  ): Promise<{ result: PipelineResult; perf?: PerfStats }> {
    const requestId = crypto.randomUUID();
    const { telemetry, signal } = options;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.listeners.delete(requestId);
        this.inflight.delete(requestId);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const abortHandler = () => {
        this.cancel(requestId);
      };

      const handleMessage: Listener = (msg) => {
        if (msg.type === 'PROGRESS') {
          telemetry?.onStage?.(msg.stage, msg.value, msg.meta);
          return;
        }
        if (msg.type === 'LOG') {
          telemetry?.onLog?.(msg.level, msg.message);
          return;
        }
        if (msg.type === 'ERROR') {
          cleanup();
          const error = new Error(msg.error.message);
          error.name = msg.error.name;
          error.stack = msg.error.stack;
          reject(error);
          return;
        }
        if (msg.type === 'RESULT') {
          cleanup();
          resolve({ result: msg.result, perf: msg.perf });
        }
      };

      this.listeners.set(requestId, handleMessage);
      this.inflight.add(requestId);

      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(Object.assign(new Error('Pipeline aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const request: WorkerRequest = { type: 'RUN', requestId, payload: input };
      this.worker.postMessage(request);
    });
  }

  cancel(requestId: string) {
    if (!this.inflight.has(requestId)) return;
    const message: WorkerRequest = { type: 'CANCEL', requestId };
    this.worker.postMessage(message);
  }

  terminate() {
    this.worker.terminate();
    this.listeners.clear();
    this.inflight.clear();
  }
}
