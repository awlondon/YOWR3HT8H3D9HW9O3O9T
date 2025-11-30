import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseRotationNarrative, isConnectionRefused } from './cognitionCycle.js';

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
