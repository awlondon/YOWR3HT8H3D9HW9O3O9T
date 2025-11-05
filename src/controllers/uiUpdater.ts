export function formatHlsfLimitValue(value: unknown): string {
  if (value === Infinity) return '∞';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '—';
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric.toLocaleString();
    }
    return trimmed;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric.toLocaleString();
  }
  return '—';
}

export function updateHlsfLimitSummary(limits?: { nodes?: unknown; edges?: unknown; relationships?: unknown }): void {
  if (typeof document === 'undefined') return;

  const nodesEl = document.querySelector<HTMLElement>('[data-hlsf-limit-nodes]');
  const edgesEl = document.querySelector<HTMLElement>('[data-hlsf-limit-edges]');
  const relEl = document.querySelector<HTMLElement>('[data-hlsf-limit-relationships]');

  if (nodesEl) nodesEl.textContent = `Nodes: ${formatHlsfLimitValue(limits?.nodes)}`;
  if (edgesEl) edgesEl.textContent = `Edges: ${formatHlsfLimitValue(limits?.edges)}`;
  if (relEl) relEl.textContent = `Relationships: ${formatHlsfLimitValue(limits?.relationships)}`;
}
