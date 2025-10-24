import { SETTINGS } from '../settings';
import type { PipelineGraph } from '../engine/pipeline';

export interface SessionExportOptions {
  tokens: string[];
  edges: PipelineGraph['edges'];
  extras?: Record<string, unknown>;
}

export function buildSessionExport({ tokens, edges, extras }: SessionExportOptions) {
  const session: Record<string, unknown> = {
    version: '2.1',
    tokens,
    graph: edges,
  };

  if (SETTINGS.tokenizeSymbols) {
    session.symbolMeta = {
      weightScale: SETTINGS.symbolWeightScale,
      emitMode: SETTINGS.symbolEmitMode,
    };
  }

  if (extras && typeof extras === 'object') {
    Object.assign(session, extras);
  }

  return session;
}
