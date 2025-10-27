import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emitPipelineTelemetry,
  registerPipelineTelemetrySink,
  getPipelineTelemetryHistory,
  resetPipelineTelemetryForTest,
} from './telemetry.js';

test('emitPipelineTelemetry normalizes top entries and updates global store', () => {
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = { CognitionEngine: {} } as any;
  try {
    resetPipelineTelemetryForTest();

    emitPipelineTelemetry({
      metrics: {
        tokenCount: 4,
        wordCount: 2,
        symbolCount: 2,
        symbolDensity: 0.5,
        edgeCount: 3,
        symbolEdgeCount: 2,
        weightSum: 0.7,
      },
      edgeHistogram: { 'modifier:emphasis': 2 },
      top: [
        { token: 'hello', rawScore: 3 },
        { token: '!', kind: 'sym', score: 0.4 },
      ],
      settings: {
        tokenizeSymbols: true,
        symbolWeightScale: 0.35,
        symbolEmitMode: 'both',
        includeSymbolInSummaries: false,
      },
    });

    const history = getPipelineTelemetryHistory();
    assert.equal(history.length, 1);
    const payload = history[0];
    assert.equal(payload.top[0].token, 'hello');
    assert.equal(payload.top[0].score, 3);
    assert.equal(payload.top[1].token, '!');
    assert.equal(payload.top[1].score, 0.4);
    assert.equal(payload.topDrift.entered.includes('hello'), true);
    assert.equal(payload.topDrift.entered.includes('!'), true);

    const store = ((globalThis as any).window.CognitionEngine as any).telemetry;
    assert.equal(Array.isArray(store.pipelineHistory), true);
    assert.equal(store.pipelineHistory.length, 1);
    assert.equal(store.lastPipelineTelemetry.top[0].token, 'hello');
  } finally {
    resetPipelineTelemetryForTest();
    (globalThis as any).window = originalWindow;
  }
});

test('pipeline telemetry drift tracks movements, entries, and exits', () => {
  resetPipelineTelemetryForTest();

  emitPipelineTelemetry({
    metrics: {
      tokenCount: 3,
      wordCount: 2,
      symbolCount: 1,
      symbolDensity: 0.33,
      edgeCount: 2,
      symbolEdgeCount: 1,
      weightSum: 0.2,
    },
    edgeHistogram: {},
    top: [
      { token: 'alpha', score: 1 },
      { token: 'beta', score: 0.5 },
    ],
    settings: {
      tokenizeSymbols: true,
      symbolWeightScale: 0.5,
      symbolEmitMode: 'paired',
      includeSymbolInSummaries: false,
    },
  });

  emitPipelineTelemetry({
    metrics: {
      tokenCount: 4,
      wordCount: 3,
      symbolCount: 1,
      symbolDensity: 0.25,
      edgeCount: 3,
      symbolEdgeCount: 1,
      weightSum: 0.4,
    },
    edgeHistogram: {},
    top: [
      { token: 'beta', score: 0.8 },
      { token: 'gamma', score: 0.6 },
    ],
    settings: {
      tokenizeSymbols: true,
      symbolWeightScale: 0.5,
      symbolEmitMode: 'paired',
      includeSymbolInSummaries: false,
    },
  });

  const history = getPipelineTelemetryHistory();
  assert.equal(history.length, 2);
  const drift = history[history.length - 1].topDrift;
  assert.equal(drift.entered.includes('gamma'), true);
  assert.equal(drift.exited.includes('alpha'), true);
  const betaMovement = drift.moved.find(move => move.token === 'beta');
  assert.equal(Boolean(betaMovement), true);
  assert.equal(betaMovement?.from, 2);
  assert.equal(betaMovement?.to, 1);
  assert.equal(betaMovement?.delta, 1);
});

test('telemetry history keeps only the most recent 50 entries and respects sink subscriptions', () => {
  resetPipelineTelemetryForTest();
  const received: number[] = [];
  const unsubscribe = registerPipelineTelemetrySink(payload => {
    received.push(payload.metrics.tokenCount);
  });

  for (let i = 0; i < 55; i += 1) {
    emitPipelineTelemetry({
      metrics: {
        tokenCount: i,
        wordCount: 0,
        symbolCount: 0,
        symbolDensity: 0,
        edgeCount: 0,
        symbolEdgeCount: 0,
        weightSum: 0,
      },
      edgeHistogram: {},
      top: [],
      settings: {
        tokenizeSymbols: true,
        symbolWeightScale: 0.35,
        symbolEmitMode: 'paired',
        includeSymbolInSummaries: false,
      },
    });
  }

  unsubscribe();
  emitPipelineTelemetry({
    metrics: {
      tokenCount: 999,
      wordCount: 0,
      symbolCount: 0,
      symbolDensity: 0,
      edgeCount: 0,
      symbolEdgeCount: 0,
      weightSum: 0,
    },
    edgeHistogram: {},
    top: [],
    settings: {
      tokenizeSymbols: true,
      symbolWeightScale: 0.35,
      symbolEmitMode: 'paired',
      includeSymbolInSummaries: false,
    },
  });

  const history = getPipelineTelemetryHistory();
  assert.equal(history.length, 50);
  assert.equal(history[0].metrics.tokenCount, 6);
  assert.equal(history[history.length - 1].metrics.tokenCount, 999);
  assert.equal(received.includes(0), true);
  assert.equal(received.includes(999), false);
});
