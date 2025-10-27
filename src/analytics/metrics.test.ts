import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustedWeight, nodeScore, rankNodes } from './metrics.js';
import { SETTINGS } from '../settings.js';

test('adjustedWeight scales modifier edges and leaves others unchanged', () => {
  const baseEdge = { type: 'relation', w: 2 };
  const modifierEdge = { type: 'modifier:emphasis', w: 2 };
  const originalScale = SETTINGS.symbolWeightScale;
  SETTINGS.symbolWeightScale = 0.5;
  try {
    assert.equal(adjustedWeight(baseEdge), 2);
    assert.equal(adjustedWeight(modifierEdge), 1);
  } finally {
    SETTINGS.symbolWeightScale = originalScale;
  }
});

test('nodeScore multiplies symbol nodes by the configured scale', () => {
  const originalScale = SETTINGS.symbolWeightScale;
  SETTINGS.symbolWeightScale = 1.6;
  try {
    const wordScore = nodeScore({ kind: 'word', rawScore: 2 });
    const symScore = nodeScore({ kind: 'sym', rawScore: 1 });
    assert.equal(wordScore, 2);
    assert.equal(symScore, 1.6);
  } finally {
    SETTINGS.symbolWeightScale = originalScale;
  }
});

test('rankNodes respects includeSymbolInSummaries flag', () => {
  const originalInclude = SETTINGS.includeSymbolInSummaries;
  const nodes = [
    { token: 'hello', kind: 'word', rawScore: 3 },
    { token: '!', kind: 'sym', rawScore: 1 },
  ];

  try {
    SETTINGS.includeSymbolInSummaries = false;
    const rankedWithoutSymbols = rankNodes(nodes as any, 5);
    assert.equal(rankedWithoutSymbols.some(node => node.token === '!'), false);

    SETTINGS.includeSymbolInSummaries = true;
    const rankedWithSymbols = rankNodes(nodes as any, 5);
    assert.equal(rankedWithSymbols.some(node => node.token === '!'), true);
  } finally {
    SETTINGS.includeSymbolInSummaries = originalInclude;
  }
});
