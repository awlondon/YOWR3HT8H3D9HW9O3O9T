import type { Settings } from '../settings.js';
import type { PipelineResult } from '../engine/pipeline.js';

export type PipelineStage =
  | 'tokenize'
  | 'adjacency'
  | 'propagate'
  | 'prune'
  | 'rank'
  | 'finalize';

export interface PipelineOptions extends Settings {}

export interface PipelineInput {
  text: string;
  options?: PipelineOptions;
}

export interface PerfStats {
  totalMs: number;
  byStage?: Partial<Record<PipelineStage, number>>;
}

export type WorkerRequest =
  | { type: 'RUN'; requestId: string; payload: PipelineInput }
  | { type: 'CANCEL'; requestId: string };

export type WorkerResponse =
  | { type: 'RESULT'; requestId: string; result: PipelineResult; perf?: PerfStats; transferables?: number }
  | { type: 'PROGRESS'; requestId: string; stage: PipelineStage; value: number; meta?: Record<string, unknown> }
  | { type: 'ERROR'; requestId: string; error: { name: string; message: string; stack?: string } }
  | { type: 'LOG'; requestId: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export interface TelemetryHook {
  onStage?: (stage: PipelineStage, pct: number, meta?: Record<string, unknown>) => void;
  onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  onMetric?: (name: string, value: number) => void;
}
