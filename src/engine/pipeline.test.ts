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
