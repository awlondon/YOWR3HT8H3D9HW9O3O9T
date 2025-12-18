import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from './pipeline.js';
import { MemoryStore } from '../lib/storage/cacheStore.js';
import { SETTINGS } from '../settings.js';
import { getPipelineTelemetryHistory } from '../analytics/telemetry.js';
import { registerEmbedding, clearRegisteredEmbeddings } from '../vector/similarity.js';
import {
  resolveLimitsFromSettings,
  syntheticBranchingExpansion,
  stronglyConnectedFromEdges,
} from './syntheticExpansion.js';

test('runPipeline emits symbol edges with cached neighbors', () => {
  const input = 'Hello, world!';
  const initialHistoryLength = getPipelineTelemetryHistory().length;
  const result = runPipeline(input, { ...SETTINGS, tokenizeSymbols: true });

  assert.equal(result.metrics.tokenCount, 4);
  assert.equal(result.metrics.wordCount, 2);
  assert.equal(result.metrics.symbolCount, 2);
  const symbolEdges = result.edges.filter(edge => edge.type && edge.type.startsWith('modifier'));
  assert.equal(symbolEdges.length, result.metrics.symbolEdgeCount);
  assert.equal(
    symbolEdges.some(edge => edge.source === 'Hello' && edge.target === ','),
    true,
    'comma should bind to preceding word'
  );
  assert.equal(
    symbolEdges.some(edge => edge.source === 'world' && edge.target === '!'),
    true,
    'exclamation mark should bind to preceding word'
  );

  const history = getPipelineTelemetryHistory();
  assert.equal(history.length, initialHistoryLength + 1);
  const last = history[history.length - 1];
  assert.equal(last.metrics.symbolCount, result.metrics.symbolCount);
  assert.equal(last.top.length <= 20, true, 'top nodes should be truncated');
});

test('symbol edge limits scale with symbol density', () => {
  const dense = 'alpha! beta! gamma! delta! epsilon!';
  const before = getPipelineTelemetryHistory().length;
  const result = runPipeline(dense, { ...SETTINGS, tokenizeSymbols: true });
  assert.equal(result.metrics.symbolCount, 5);
  assert.equal(result.metrics.symbolEdgeCount >= 5, true, 'should generate symbol edges for exclamations');
  assert.equal(result.metrics.weightSum > 0, true, 'symbol edge weights should accumulate');

  const history = getPipelineTelemetryHistory();
  assert.equal(history.length, before + 1);
  const last = history[history.length - 1];
  const emphasisEdges = last.edgeHistogram['modifier:emphasis'] || 0;
  assert.equal(emphasisEdges >= 5, true, 'modifier emphasis edges should be counted');
  assert.equal(Array.isArray(last.topDrift.entered), true, 'top drift should expose entered tokens');
});

test('syntheticBranchingExpansion respects limits and deterministic rng', () => {
  const nodes = [
    { token: 'alpha', kind: 'word', rawScore: 1, index: 0, cat: null as string | null },
  ];
  const acc = { edges: [] as Array<{ source?: string; target?: string; type?: string; w?: number }> };
  const limits = resolveLimitsFromSettings({
    branchingFactor: 12,
    maxNodes: 15,
    maxEdges: 60,
    maxAdjacencyLayers: 2,
    maxAdjacencyDegreePerLayer: [3, 2],
    adjacencySimilarityThreshold: 0,
    adjacencyStrongSimilarityThreshold: 0.5,
  });
  const cacheStore = new MemoryStore<unknown>();
  const deterministicValues = [0.1, 0.2, 0.3];
  let idx = 0;
  const rng = () => {
    const value = deterministicValues[idx % deterministicValues.length];
    idx += 1;
    return value;
  };

  syntheticBranchingExpansion(nodes, acc, ['alpha'], limits, cacheStore, rng);

  assert.equal(nodes.length <= limits.maxNodes, true, 'node count should respect limit');
  assert.equal(acc.edges.length <= limits.maxEdges, true, 'edge count should respect limit');
  const undirectedEdges = acc.edges
    .filter((edge) => Boolean(edge.source && edge.target))
    .map((edge) => ({ source: edge.source as string, target: edge.target as string }));
  assert.equal(
    stronglyConnectedFromEdges(nodes, undirectedEdges),
    true,
    'graph should stay connected',
  );
  const generatedLabels = nodes.map((node) => node.token).filter((token) => token !== 'alpha');
  assert.equal(
    generatedLabels.some((token) => token.includes('3ll')),
    true,
    'deterministic rng suffix should appear in fallback child tokens',
  );
});

test('runPipeline builds bounded recursive adjacency graph', () => {
  const input = 'alpha beta gamma delta epsilon';
  clearRegisteredEmbeddings();
  for (const word of input.split(' ')) {
    registerEmbedding(word, [1, 0, 0]);
  }
  const result = runPipeline(input, {
    ...SETTINGS,
    tokenizeSymbols: false,
    adjacencySimilarityThreshold: 0.1,
    adjacencyStrongSimilarityThreshold: 0.8,
  });

  const adjacencyEdges = result.edges.filter(edge => edge.type && edge.type.startsWith('adjacency:'));
  const maxExpected = Math.floor((SETTINGS.maxAdjacencyEdgesMultiplier ?? 6) * result.tokens.length);

  assert.equal(adjacencyEdges.length >= result.tokens.length, true, 'base adjacency should connect the full ring');
  assert.equal(
    adjacencyEdges.length <= maxExpected,
    true,
    'adjacency expansion should respect configured edge multiplier',
  );

  const metadataLevels = new Set<number>();
  for (const edge of adjacencyEdges) {
    const level = (edge.meta as { level?: number }).level ?? (edge as any).level;
    if (typeof level === 'number') {
      metadataLevels.add(level);
    }
  }

  assert.equal(metadataLevels.has(0), true, 'base edges should expose level metadata');
  assert.equal(metadataLevels.size >= 2, true, 'expanded edges should include higher-level metadata');
  assert.equal(
    adjacencyEdges.every(edge => edge.family),
    true,
    'adjacency edges should carry adjacency family classification',
  );
});

test('single token prompt seeds cached highest-weight adjacencies', () => {
  const token = 'solo';
  const cachedRecord = {
    token,
    relationships: {
      '⇄': [
        { token: 'Alpha', weight: 0.9 },
        { token: 'Gamma', weight: 0.8 },
      ],
      '∼': [
        { token: 'Beta', weight: 0.4 },
        { token: 'alpha', weight: 0.6 },
      ],
    },
  };

  const cacheStore = new MemoryStore<unknown>();
  cacheStore.set(token, cachedRecord);
  cacheStore.set(token.toLowerCase(), cachedRecord);

  try {
    clearRegisteredEmbeddings();
    registerEmbedding('solo', [1, 0, 0]);
    registerEmbedding('Alpha', [1, 0, 0]);
    registerEmbedding('alpha', [1, 0, 0]);
    registerEmbedding('Gamma', [1, 0, 0]);
    registerEmbedding('Beta', [0, 1, 0]);
    const result = runPipeline(token, {
      ...SETTINGS,
      tokenizeSymbols: false,
      adjacencySimilarityThreshold: 0.1,
      adjacencyStrongSimilarityThreshold: 0.9,
    }, { cacheStore });
    const nodeTokens = result.graph.nodes.map(node => node.token);

    assert.equal(nodeTokens.includes('Alpha'), true, 'top adjacency token should be promoted to node');
    assert.equal(nodeTokens.includes('Gamma'), true, 'second highest adjacency token should be promoted to node');

    const cachedEdges = result.edges.filter(edge => edge.type === 'adjacency:cached');
    const soloEdges = cachedEdges.filter(edge => edge.source === token);
    const neighborTargets = new Set(soloEdges.map(edge => edge.target));

    assert.equal(neighborTargets.has('Alpha'), true, 'solo should connect to highest-weight neighbor');
    assert.equal(neighborTargets.has('Gamma'), true, 'solo should connect to next highest-weight neighbor');
    assert.equal(soloEdges.length >= 2, true, 'solo should emit at least two cached adjacency edges');
  } finally {
    clearRegisteredEmbeddings();
  }
});

test('runPipeline aborts when shouldAbort flips during execution', () => {
  let checks = 0;
  const hooks = {
    shouldAbort: () => {
      checks += 1;
      return checks > 3;
    },
  };
  assert.throws(
    () => runPipeline('Abort me softly', { ...SETTINGS }, hooks),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
    'pipeline should raise AbortError when hook triggers',
  );
});

test('runPipeline metrics remain consistent across symbol densities', () => {
  const plainResult = runPipeline('hello world', { ...SETTINGS, tokenizeSymbols: true });
  assert.equal(plainResult.metrics.tokenCount, plainResult.tokens.length);
  assert.equal(plainResult.metrics.wordCount, 2);
  assert.equal(plainResult.metrics.symbolCount, 0);
  assert.equal(plainResult.metrics.symbolDensity, 0);

  const symbolRich = runPipeline('hello, world!', { ...SETTINGS, tokenizeSymbols: true });
  assert.equal(symbolRich.metrics.tokenCount, symbolRich.tokens.length);
  assert.equal(symbolRich.metrics.wordCount >= 2, true);
  assert.equal(symbolRich.metrics.symbolCount >= 1, true, 'punctuation should be counted as symbol tokens');
  assert.equal(
    symbolRich.metrics.symbolDensity,
    symbolRich.metrics.tokenCount === 0
      ? 0
      : symbolRich.metrics.symbolCount / symbolRich.metrics.tokenCount,
  );
  assert.equal(symbolRich.metrics.edgeCount, symbolRich.edges.length);
  assert.equal(symbolRich.metrics.symbolEdgeCount >= 0, true);
});

test('adjacency edges respect configured multiplier caps', () => {
  const input = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
  const settings = {
    ...SETTINGS,
    tokenizeSymbols: false,
    maxAdjacencyEdgesMultiplier: 1,
  };
  const result = runPipeline(input, settings);
  const adjacencyEdges = result.edges.filter((edge) => edge.type?.startsWith('adjacency:'));
  const expectedCap = Math.max(result.tokens.length, Math.floor(result.tokens.length));
  assert.equal(
    adjacencyEdges.length <= expectedCap,
    true,
    'adjacency edge count should remain within multiplier-derived cap',
  );
});

test('pipeline enforces small graph limits without emptying results', () => {
  const settings = {
    ...SETTINGS,
    maxNodes: 10,
    maxEdges: 50,
    branchingFactor: 2,
  };
  const result = runPipeline('delta epsilon zeta eta theta iota kappa lambda mu nu', settings);
  assert.equal(result.graph.nodes.length > 0, true, 'should still produce nodes');
  assert.equal(result.edges.length > 0, true, 'should still produce edges');
  assert.equal(result.graph.nodes.length <= settings.maxNodes, true);
  assert.equal(result.edges.length <= settings.maxEdges, true);
});

test('runPipeline synthesizes a consciousness workspace with recurrent monitoring', () => {
  const input = 'Global workspace integration enables conscious broadcasting!';
  const result = runPipeline(input, { ...SETTINGS, tokenizeSymbols: true });

  const consciousness = result.consciousness;
  assert.equal(Boolean(consciousness), true, 'pipeline should expose consciousness state');
  assert.equal(
    consciousness.workspace.broadcast.length > 0,
    true,
    'workspace broadcast should contain salient tokens',
  );
  assert.equal(
    consciousness.workspace.iterations >= 1,
    true,
    'recurrent loop should run at least once',
  );
  assert.equal(
    consciousness.meta.integrationScore >= 0 && consciousness.meta.integrationScore <= 1,
    true,
    'integration score should be normalized',
  );
  assert.equal(
    consciousness.meta.causalImpact.length <= 5,
    true,
    'causal impact estimates should be limited to top signals',
  );
  const [primarySignal] = consciousness.workspace.broadcast;
  assert.equal(
    Array.isArray(primarySignal?.sources) && primarySignal.sources.length >= 1,
    true,
    'primary signal should track contributing sources',
  );
  assert.equal(
    Array.isArray(consciousness.meta.notes) && consciousness.meta.notes.length >= 1,
    true,
    'meta monitoring should surface narrative notes',
  );
});
