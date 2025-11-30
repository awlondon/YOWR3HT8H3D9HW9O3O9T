import test from 'node:test';
import assert from 'node:assert/strict';
import { isConnectionRefused } from './cognitionCycle.js';

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
