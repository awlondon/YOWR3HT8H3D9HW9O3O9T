import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseRotationNarrative, isConnectionRefused, callLLM as runCallLLM } from './cognitionCycle.js';

test('detects ECONNREFUSED codes nested inside AggregateError errors array', () => {
  const aggregate = {
    name: 'AggregateError',
    errors: [{ code: 'ECONNREFUSED', message: 'connect failed' }],
  };

  assert.equal(isConnectionRefused(aggregate), true);
});

test('detects ECONNREFUSED codes nested inside causes', () => {
  const aggregate = {
    name: 'AggregateError',
    errors: [{ message: 'socket hang up', cause: { code: 'ECONNREFUSED' } }],
    message: 'AggregateError [ECONNREFUSED] in request',
  };

  assert.equal(isConnectionRefused(aggregate), true);
});

test('collapseRotationNarrative trims rotation narratives to 100 words', () => {
  const rotationNarrative = Array.from({ length: 4 }, (_, i) =>
    `Axis ${i + 1} intersections ${Array.from({ length: 30 }, (_, j) => `token${i}-${j}`).join(' ')}`,
  );
  const collapsed = collapseRotationNarrative(rotationNarrative, 100);

  assert.equal(typeof collapsed, 'string');
  const wordCount = collapsed?.split(/\s+/).filter(Boolean).length ?? 0;
  assert.equal(wordCount <= 100, true);
  assert.equal(collapsed?.includes('Axis 1 intersections'), true);
});

test('callLLM surfaces backend errors without falling back to stub text when stub is off', async () => {
  const originalEnv = (import.meta as any).env;
  const originalFetch = globalThis.fetch;
  (import.meta as any).env = { VITE_ENABLE_LLM_STUB: 'off', DEV: false, VITE_LLM_ENDPOINT: '/api/llm' } as any;

  globalThis.fetch = async () =>
    new Response('backend failed', { status: 500, headers: { 'Content-Type': 'text/plain' } });

  try {
    const config = {
      thinkingStyle: 'concise',
      iterations: 1,
      rotationSpeed: 1,
      affinityThreshold: 0.5,
      maxPromptWords: 10,
      maxIterations: 1,
    } as any;

    const result = await runCallLLM('prompt', ['ctx'], config, 'visible' as any, [], {
      rawPrompt: 'prompt',
      adjacencyTokens: ['a', 'b'],
    });

    assert.equal(/HTTP 500/.test(result.error || ''), true);
    assert.equal(/stub/i.test(result.error || ''), false);
    assert.equal(result.fallbackReason, 'llm-error');
  } finally {
    (import.meta as any).env = originalEnv;
    globalThis.fetch = originalFetch;
  }
});
