/// <reference lib="webworker" />

import { SETTINGS } from '../settings.js';
import { runPipeline } from '../engine/pipeline.js';
import type {
  PipelineStage,
  PerfStats,
  TelemetryHook,
  WorkerRequest,
  WorkerResponse,
} from '../types/pipeline-messages.js';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const abortMap = new Map<string, { aborted: boolean }>();

const postMessageFromWorker = (message: WorkerResponse, transferables?: Transferable[]) => {
  ctx.postMessage(message, transferables ?? []);
};

const collectTransferables = (value: unknown): Transferable[] => {
  const buffers = new Set<ArrayBuffer>();
  const transferables: Transferable[] = [];

  const visit = (candidate: any) => {
    if (!candidate) return;
    if (candidate instanceof ArrayBuffer) {
      if (!buffers.has(candidate)) {
        buffers.add(candidate);
        transferables.push(candidate);
      }
      return;
    }
    if (ArrayBuffer.isView(candidate) && candidate.buffer instanceof ArrayBuffer) {
      if (!buffers.has(candidate.buffer)) {
        buffers.add(candidate.buffer);
        transferables.push(candidate.buffer);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry);
      }
      return;
    }
    if (typeof candidate === 'object') {
      for (const entry of Object.values(candidate)) {
        visit(entry);
      }
    }
  };

  visit(value);
  return transferables;
};

const createTelemetry = (
  requestId: string,
  perf: PerfStats,
): TelemetryHook => {
  const stageStarts = new Map<PipelineStage, number>();
  const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

  if (!perf.byStage) {
    perf.byStage = {};
  }

  return {
    onStage: (stage, pct, meta) => {
      if (pct <= 0) {
        stageStarts.set(stage, now());
      } else if (pct >= 1) {
        const startedAt = stageStarts.get(stage);
        const duration = typeof meta?.durationMs === 'number'
          ? meta.durationMs
          : typeof startedAt === 'number'
            ? Math.max(0, now() - startedAt)
            : undefined;
        if (typeof duration === 'number') {
          perf.byStage![stage] = duration;
        }
      }
      postMessageFromWorker({ type: 'PROGRESS', requestId, stage, value: pct, meta });
    },
    onLog: (level, message) => {
      postMessageFromWorker({ type: 'LOG', requestId, level, message });
    },
  };
};

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message) return;

  if (message.type === 'CANCEL') {
    const ref = abortMap.get(message.requestId);
    if (ref) {
      ref.aborted = true;
    }
    return;
  }

  if (message.type !== 'RUN') {
    return;
  }

  const { requestId, payload } = message;
  const abortRef = { aborted: false };
  abortMap.set(requestId, abortRef);

  const perf: PerfStats = { totalMs: 0, byStage: {} };
  const startTime = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  const telemetry = createTelemetry(requestId, perf);

  try {
    const { result } = await Promise.resolve().then(() =>
      runPipeline(payload.text, payload.options ?? SETTINGS, {
        telemetry,
        shouldAbort: () => abortRef.aborted,
      }),
    );

    perf.totalMs = (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()) - startTime;

    const transferables = collectTransferables(result);
    postMessageFromWorker(
      { type: 'RESULT', requestId, result, perf, transferables: transferables.length },
      transferables,
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    postMessageFromWorker({
      type: 'ERROR',
      requestId,
      error: {
        name: error.name || 'Error',
        message: error.message,
        stack: error.stack,
      },
    });
  } finally {
    abortMap.delete(requestId);
  }
};
