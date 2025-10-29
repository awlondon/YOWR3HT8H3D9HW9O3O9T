import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecursiveAdjacency } from './recursive_adjacency.js';
import type { Token } from '../tokens/tokenize.js';

function buildTokens(words: string[]): Token[] {
  return words.map((word, index) => ({
    t: word,
    kind: 'word' as const,
    cat: null,
    i: index,
    n: 1,
  }));
}

test('buildRecursiveAdjacency respects configured edge limits', () => {
  const wordCount = 120;
  const tokens = buildTokens(Array.from({ length: wordCount }, (_, i) => `token-${i}`));
  const maxEdges = wordCount * 4;
  const edges = buildRecursiveAdjacency(tokens, {
    maxDepth: 4,
    maxDegree: 10,
    maxEdges,
  });

  assert.equal(edges.length <= maxEdges, true, 'edge count should never exceed configured limit');
  const baseEdges = edges.filter(edge => edge.type === 'adjacency:base');
  assert.equal(baseEdges.length, wordCount, 'base adjacency should form a circular backbone');
});

test('buildRecursiveAdjacency bounds expanded degree growth and annotates metadata', () => {
  const tokens = buildTokens([
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
    'kappa',
  ]);

  const edges = buildRecursiveAdjacency(tokens, {
    maxDepth: 3,
    maxDegree: 4,
    maxEdges: 60,
  });

  const adjacency = new Map<number, Set<number>>();
  for (const edge of edges) {
    const { sourceIndex, targetIndex } = edge;
    if (!adjacency.has(sourceIndex)) adjacency.set(sourceIndex, new Set());
    if (!adjacency.has(targetIndex)) adjacency.set(targetIndex, new Set());
    adjacency.get(sourceIndex)!.add(targetIndex);
    adjacency.get(targetIndex)!.add(sourceIndex);
  }

  for (const neighbors of adjacency.values()) {
    assert.equal(neighbors.size <= 4, true, 'expanded graph should respect maxDegree bounds');
  }

  assert.equal(edges.some(edge => (edge.meta as { level?: number }).level === 0), true, 'level metadata should include base edges');
  assert.equal(
    edges.some(edge => {
      const meta = edge.meta as { level?: number; viaToken?: string };
      return typeof meta.level === 'number' && meta.level > 0 && typeof meta.viaToken === 'string';
    }),
    true,
    'expanded edges should record intermediary nodes in metadata',
  );
});
