export interface PipelineTelemetryMetrics {
  tokenCount: number;
  wordCount: number;
  symbolCount: number;
  symbolDensity: number;
  edgeCount: number;
  symbolEdgeCount: number;
  weightSum: number;
}

export interface PipelineTelemetrySettings {
  tokenizeSymbols: boolean;
  symbolWeightScale: number;
  symbolEmitMode: string;
  includeSymbolInSummaries: boolean;
}

export interface PipelineTelemetryTopInput {
  token?: string;
  kind?: string;
  score?: number;
  rawScore?: number;
}

export interface PipelineTelemetryTopNode {
  token: string;
  kind?: string;
  score: number;
  rank: number;
}

export interface PipelineTopMovement {
  token: string;
  from: number;
  to: number;
  delta: number;
  scoreChange: number;
}

export interface PipelineTopDrift {
  entered: string[];
  exited: string[];
  moved: PipelineTopMovement[];
}

export interface PipelineTelemetryPayload {
  timestamp: string;
  metrics: PipelineTelemetryMetrics;
  edgeHistogram: Record<string, number>;
  top: PipelineTelemetryTopNode[];
  topDrift: PipelineTopDrift;
  settings: PipelineTelemetrySettings;
}

export interface PipelineTelemetryEvent {
  metrics: PipelineTelemetryMetrics;
  edgeHistogram: Record<string, number>;
  top: PipelineTelemetryTopInput[];
  settings: PipelineTelemetrySettings;
}

export type PipelineTelemetrySink = (payload: PipelineTelemetryPayload) => void;

const sinks = new Set<PipelineTelemetrySink>();
const history: PipelineTelemetryPayload[] = [];
const MAX_HISTORY = 50;
let previousTopSnapshot = new Map<string, { rank: number; score: number }>();

function getGlobalTelemetryStore(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  const root = ((window as any).CognitionEngine = (window as any).CognitionEngine || {});
  root.telemetry = root.telemetry || {};
  return root.telemetry as Record<string, unknown>;
}

function normalizeTop(top: PipelineTelemetryTopInput[]): PipelineTelemetryTopNode[] {
  const normalized: PipelineTelemetryTopNode[] = [];
  for (let i = 0; i < top.length; i += 1) {
    const raw = top[i];
    if (!raw) continue;
    const token = typeof raw.token === 'string' && raw.token.length > 0
      ? raw.token
      : '';
    if (!token) continue;
    const score = Number.isFinite(raw.score)
      ? Number(raw.score)
      : Number.isFinite(raw.rawScore)
        ? Number(raw.rawScore)
        : 0;
    normalized.push({ token, kind: raw.kind, score, rank: i + 1 });
  }
  return normalized;
}

function computeTopDrift(top: PipelineTelemetryTopNode[]): PipelineTopDrift {
  const current = new Map<string, { rank: number; score: number }>();
  for (const node of top) {
    current.set(node.token, { rank: node.rank, score: node.score });
  }

  const entered: string[] = [];
  const moved: PipelineTopMovement[] = [];
  for (const [token, info] of current.entries()) {
    const prev = previousTopSnapshot.get(token);
    if (!prev) {
      entered.push(token);
      continue;
    }
    if (prev.rank !== info.rank || prev.score !== info.score) {
      moved.push({
        token,
        from: prev.rank,
        to: info.rank,
        delta: prev.rank - info.rank,
        scoreChange: info.score - prev.score,
      });
    }
  }

  const exited: string[] = [];
  for (const [token, info] of previousTopSnapshot.entries()) {
    if (!current.has(token)) {
      exited.push(token);
    }
  }

  previousTopSnapshot = current;
  return { entered, exited, moved };
}

export function emitPipelineTelemetry(event: PipelineTelemetryEvent): void {
  const timestamp = new Date().toISOString();
  const normalizedTop = normalizeTop(event.top);
  const topDrift = computeTopDrift(normalizedTop);

  const payload: PipelineTelemetryPayload = {
    timestamp,
    metrics: event.metrics,
    edgeHistogram: { ...event.edgeHistogram },
    top: normalizedTop,
    topDrift,
    settings: event.settings,
  };

  history.push(payload);
  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  const globalStore = getGlobalTelemetryStore();
  if (globalStore) {
    (globalStore as any).pipelineHistory = history.slice();
    (globalStore as any).lastPipelineTelemetry = payload;
  }

  for (const sink of sinks) {
    try {
      sink(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Pipeline telemetry sink failed:', err);
    }
  }
}

export function registerPipelineTelemetrySink(sink: PipelineTelemetrySink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function getPipelineTelemetryHistory(): PipelineTelemetryPayload[] {
  return history.slice();
}

/**
 * Clears telemetry history and registered sinks so that tests can execute in
 * isolation. The function is a no-op in production code but provides a
 * supported way for the test suite to reset global analytics state.
 */
export function resetPipelineTelemetryForTest(): void {
  history.length = 0;
  previousTopSnapshot = new Map();
  sinks.clear();

  const store = getGlobalTelemetryStore();
  if (store) {
    delete (store as any).pipelineHistory;
    delete (store as any).lastPipelineTelemetry;
  }
}
