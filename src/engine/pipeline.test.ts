import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from './pipeline.js';
import { SETTINGS } from '../settings.js';
import { getPipelineTelemetryHistory } from '../analytics/telemetry.js';

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

test('runPipeline builds bounded recursive adjacency graph', () => {
  const input = 'alpha beta gamma delta epsilon';
  const result = runPipeline(input, { ...SETTINGS, tokenizeSymbols: false });

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
    const level = (edge.meta as { level?: number }).level;
    if (typeof level === 'number') {
      metadataLevels.add(level);
    }
  }

  assert.equal(metadataLevels.has(0), true, 'base edges should expose level metadata');
  assert.equal(metadataLevels.size >= 2, true, 'expanded edges should include higher-level metadata');
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
