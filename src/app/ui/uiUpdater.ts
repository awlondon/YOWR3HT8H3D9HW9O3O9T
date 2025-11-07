import type { DocumentLike } from './types';

export interface HlsfLimitSummary {
  nodes?: unknown;
  edges?: unknown;
  relationships?: unknown;
}

function formatHlsfLimitValue(value: unknown): string {
  if (value === Infinity) return '∞';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric.toLocaleString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : '—';
  }
  return '—';
}

export class UIUpdater {
  constructor(private readonly documentRef: DocumentLike | null = typeof document !== 'undefined' ? document : null) {}

  updateHlsfLimitSummary(limits?: HlsfLimitSummary): void {
    const doc = this.documentRef;
    if (!doc) return;
    const summary = doc.getElementById('hlsf-limit-summary');
    if (!summary) return;
    const nodesEl = summary.querySelector('[data-hlsf-limit-nodes]');
    const edgesEl = summary.querySelector('[data-hlsf-limit-edges]');
    const relEl = summary.querySelector('[data-hlsf-limit-relationships]');
    if (nodesEl) nodesEl.textContent = `Nodes: ${formatHlsfLimitValue(limits?.nodes)}`;
    if (edgesEl) edgesEl.textContent = `Edges: ${formatHlsfLimitValue(limits?.edges)}`;
    if (relEl) relEl.textContent = `Relationships: ${formatHlsfLimitValue(limits?.relationships)}`;
    if (summary instanceof HTMLElement) {
      if (Number.isFinite(Number(limits?.nodes))) {
        summary.dataset.nodes = String(limits?.nodes ?? '');
      } else {
        delete summary.dataset.nodes;
      }
      if (Number.isFinite(Number(limits?.edges))) {
        summary.dataset.edges = String(limits?.edges ?? '');
      } else {
        delete summary.dataset.edges;
      }
      if (limits?.relationships === Infinity) {
        summary.dataset.relationships = 'Infinity';
      } else if (Number.isFinite(Number(limits?.relationships))) {
        summary.dataset.relationships = String(limits?.relationships ?? '');
      } else {
        delete summary.dataset.relationships;
      }
    }
  }
}

export const defaultUIUpdater = new UIUpdater();
