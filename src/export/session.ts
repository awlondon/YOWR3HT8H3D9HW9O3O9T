import { SETTINGS } from '../settings.js';
import type { PipelineGraph, PipelineResult } from '../engine/pipeline.js';
import { getPipelineTelemetryHistory } from '../analytics/telemetry.js';
import { getCommandUsageCounts, getCommandUsageHistory } from '../analytics/commandUsage.js';
import { getModelParamHistory } from './modelParams.js';

export interface SessionExportOptions {
  tokens: string[];
  edges: PipelineGraph['edges'];
  metrics?: PipelineResult['metrics'];
  top?: PipelineGraph['nodes'];
  settingsSnapshot?: Partial<typeof SETTINGS>;
  extras?: Record<string, unknown>;
}

export function buildSessionExport({ tokens, edges, metrics, top, settingsSnapshot, extras }: SessionExportOptions) {
  const session: Record<string, unknown> = {
    version: '2.1',
    tokens,
    graph: edges,
  };

  const snapshot = settingsSnapshot || {
    tokenizeSymbols: SETTINGS.tokenizeSymbols,
    symbolWeightScale: SETTINGS.symbolWeightScale,
    symbolEmitMode: SETTINGS.symbolEmitMode,
    includeSymbolInSummaries: SETTINGS.includeSymbolInSummaries,
  };
  session.settings = snapshot;

  if (SETTINGS.tokenizeSymbols) {
    session.symbolMeta = {
      weightScale: SETTINGS.symbolWeightScale,
      emitMode: SETTINGS.symbolEmitMode,
    };
  }

  if (metrics && typeof metrics === 'object') {
    session.metrics = metrics;
  }

  const normalizedTop = Array.isArray(top)
    ? top
        .map((node: any, index: number) => {
          if (!node || typeof node.token !== 'string') return null;
          const score = Number.isFinite(node.score)
            ? Number(node.score)
            : Number.isFinite(node.rawScore)
              ? Number(node.rawScore)
              : null;
          return {
            token: node.token,
            kind: node.kind,
            score,
            rank: index + 1,
          };
        })
        .filter(Boolean)
    : null;
  if (normalizedTop && normalizedTop.length) {
    session.topNodes = normalizedTop;
  }

  const pipelineHistory = getPipelineTelemetryHistory();
  const commandHistory = getCommandUsageHistory();
  const commandCounts = getCommandUsageCounts();
  const analytics: Record<string, unknown> = {};
  if (pipelineHistory.length) {
    analytics.pipeline = pipelineHistory;
  }
  if (commandHistory.length) {
    analytics.commands = { history: commandHistory, counts: commandCounts };
  }
  if (Object.keys(analytics).length) {
    session.analytics = analytics;
  }

  const modelParamHistory = getModelParamHistory();
  if (modelParamHistory.length) {
    session.modelParameters = { history: modelParamHistory };
  }

  if (extras && typeof extras === 'object') {
    const { metrics: metricsOverride, top: topOverride, settingsSnapshot: snapshotOverride, ...rest } = extras;
    Object.assign(session, rest);
    if (snapshotOverride && typeof snapshotOverride === 'object') {
      session.settings = Object.assign({}, session.settings, snapshotOverride);
    }
    if (!session.metrics && metricsOverride) {
      session.metrics = metricsOverride;
    }
    if (!session.topNodes && topOverride) {
      session.topNodes = topOverride;
    }
  }

  return session;
}
