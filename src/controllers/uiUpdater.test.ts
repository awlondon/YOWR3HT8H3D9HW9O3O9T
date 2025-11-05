import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHlsfLimitValue, updateHlsfLimitSummary } from './uiUpdater.js';

test('formatHlsfLimitValue normalizes different input shapes', () => {
  assert.strictEqual(formatHlsfLimitValue(1600), '1,600');
  assert.strictEqual(formatHlsfLimitValue('3200'), '3,200');
  assert.strictEqual(formatHlsfLimitValue('  '), '—');
  assert.strictEqual(formatHlsfLimitValue(Infinity), '∞');
});

test('updateHlsfLimitSummary updates the DOM via data attributes', () => {
  const nodesEl = { textContent: '' } as { textContent: string };
  const edgesEl = { textContent: '' } as { textContent: string };
  const relationshipsEl = { textContent: '' } as { textContent: string };
  const elements: Record<string, { textContent: string }> = {
    '[data-hlsf-limit-nodes]': nodesEl,
    '[data-hlsf-limit-edges]': edgesEl,
    '[data-hlsf-limit-relationships]': relationshipsEl,
  };

  const originalDocument = (globalThis as any).document;
  (globalThis as any).document = {
    querySelector: (selector: string) => elements[selector] ?? null,
  } as Partial<Document>;

  try {
    updateHlsfLimitSummary({ nodes: 1600, edges: 6400, relationships: 4200 });
    assert.strictEqual(nodesEl.textContent, 'Nodes: 1,600');
    assert.strictEqual(edgesEl.textContent, 'Edges: 6,400');
    assert.strictEqual(relationshipsEl.textContent, 'Relationships: 4,200');
  } finally {
    (globalThis as any).document = originalDocument;
  }
});
