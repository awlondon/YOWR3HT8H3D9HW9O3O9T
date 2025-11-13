import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecursiveAdjacency } from './recursive_adjacency.js';
import type { Token } from '../../tokens/tokenize.js';
import { registerEmbedding, clearRegisteredEmbeddings } from '../../vector/similarity.js';

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
  clearRegisteredEmbeddings();
  const wordCount = 120;
  const tokens = buildTokens(Array.from({ length: wordCount }, (_, i) => `token-${i}`));
  for (const token of tokens) {
    registerEmbedding(token.t, [1, 0, 0]);
  }
  const maxEdges = wordCount * 4;
  const edges = buildRecursiveAdjacency(tokens, {
    maxDepth: 4,
    maxDegree: 10,
    maxEdges,
    maxLayers: 3,
    maxDegreePerLayer: [4, 3, 2],
    similarityThreshold: 0.2,
  });

  assert.equal(edges.length <= maxEdges, true, 'edge count should never exceed configured limit');
  const baseEdges = edges.filter(edge => edge.type === 'adjacency:base');
  assert.equal(baseEdges.length, wordCount, 'base adjacency should form a circular backbone');
});

test('buildRecursiveAdjacency bounds expanded degree growth and annotates metadata', () => {
  clearRegisteredEmbeddings();
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

  for (const token of tokens) {
    registerEmbedding(token.t, [1, 0, 0]);
  }

  const edges = buildRecursiveAdjacency(tokens, {
    maxLayers: 3,
    maxDegreePerLayer: [4, 3, 2],
    maxEdges: 60,
    similarityThreshold: 0.2,
  });

  const perLevelCounts = new Map<number, Map<number, number>>();
  for (const edge of edges) {
    if (edge.level <= 0) continue;
    const levelCountsA = perLevelCounts.get(edge.sourceIndex) ?? new Map();
    const levelCountsB = perLevelCounts.get(edge.targetIndex) ?? new Map();
    levelCountsA.set(edge.level, (levelCountsA.get(edge.level) ?? 0) + 1);
    levelCountsB.set(edge.level, (levelCountsB.get(edge.level) ?? 0) + 1);
    perLevelCounts.set(edge.sourceIndex, levelCountsA);
    perLevelCounts.set(edge.targetIndex, levelCountsB);
  }

  for (const levelCounts of perLevelCounts.values()) {
    for (const [level, count] of levelCounts.entries()) {
      const limit = level === 1 ? 4 : level === 2 ? 3 : 2;
      assert.equal(count <= limit, true, `nodes should respect per-layer degree limit at level ${level}`);
    }
  }

  assert.equal(edges.some(edge => edge.level === 0), true, 'level metadata should include base edges');
  assert.equal(
    edges.some(edge => {
      return typeof edge.level === 'number' && edge.level > 0 && typeof edge.meta?.viaToken === 'string';
    }),
    true,
    'expanded edges should record intermediary nodes in metadata',
  );
  assert.equal(
    edges.some(edge => typeof edge.similarity === 'number' && edge.level > 0),
    true,
    'expanded edges should include similarity annotations',
  );
});

test('similarity gating suppresses weak edges', () => {
  clearRegisteredEmbeddings();
  const tokens = buildTokens(['north', 'south', 'east', 'west']);
  registerEmbedding('north', [1, 0, 0]);
  registerEmbedding('south', [1, 0, 0]);
  registerEmbedding('east', [0, 1, 0]);
  registerEmbedding('west', [0, 0, 1]);

  const edges = buildRecursiveAdjacency(tokens, {
    maxLayers: 2,
    maxDegreePerLayer: [2, 1],
    similarityThreshold: 0.5,
    strongSimilarityThreshold: 0.9,
    maxEdges: 20,
  });

  const expanded = edges.filter(edge => edge.level > 0);
  assert.equal(
    expanded.every(edge => (edge.similarity ?? 0) >= 0.5),
    true,
    'all expanded edges should meet similarity threshold',
  );
});

test('high similarity tokens become connected within bounded hops', () => {
  clearRegisteredEmbeddings();
  const tokens = buildTokens(['one', 'two', 'three', 'four', 'five', 'six']);
  for (const token of tokens) {
    registerEmbedding(token.t, [1, 0, 0]);
  }

  const edges = buildRecursiveAdjacency(tokens, {
    maxLayers: 2,
    maxDegreePerLayer: [3, 2],
    similarityThreshold: 0.1,
    strongSimilarityThreshold: 0.8,
    maxEdges: 40,
  });

  const adjacency = new Map<number, Set<number>>();
  for (const edge of edges) {
    const { sourceIndex, targetIndex } = edge;
    if (!adjacency.has(sourceIndex)) adjacency.set(sourceIndex, new Set());
    if (!adjacency.has(targetIndex)) adjacency.set(targetIndex, new Set());
    adjacency.get(sourceIndex)!.add(targetIndex);
    adjacency.get(targetIndex)!.add(sourceIndex);
  }

  const distance = (start: number, end: number): number => {
    const seen = new Set<number>([start]);
    const queue: Array<{ node: number; depth: number }> = [{ node: start, depth: 0 }];
    while (queue.length) {
      const { node, depth } = queue.shift()!;
      if (node === end) return depth;
      if (depth >= 10) continue;
      for (const next of adjacency.get(node) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push({ node: next, depth: depth + 1 });
      }
    }
    return Number.POSITIVE_INFINITY;
  };

  const span = distance(0, 4); // one -> five
  assert.equal(span <= 2, true, 'bounded hop expansion should provide a short path between similar tokens');
});
