import test from 'node:test';
import assert from 'node:assert/strict';

import { getStubMode } from './stubMode.js';

test('stub mode respects explicit on/off', () => {
  const onMode = getStubMode({ VITE_ENABLE_LLM_STUB: 'on' });
  assert.equal(onMode.enabled, true);
  assert.equal(onMode.reason, 'env:on');

  const offMode = getStubMode({ VITE_ENABLE_LLM_STUB: 'off' });
  assert.equal(offMode.enabled, false);
  assert.equal(offMode.reason, 'env:off');
});

test('stub mode auto enables for dev default endpoint', () => {
  const result = getStubMode({ DEV: true, VITE_ENABLE_LLM_STUB: 'auto', VITE_LLM_ENDPOINT: '/api/llm' });
  assert.equal(result.enabled, true);
  assert.equal(result.reason, 'auto:dev-default');
});

test('stub mode auto disables when endpoint configured', () => {
  const result = getStubMode({ DEV: true, VITE_ENABLE_LLM_STUB: 'auto', VITE_LLM_ENDPOINT: 'http://example.com/api/llm' });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'auto:endpoint-configured');
});

test('stub mode auto disables in prod', () => {
  const result = getStubMode({ DEV: false, VITE_ENABLE_LLM_STUB: 'auto', VITE_LLM_ENDPOINT: '/api/llm' });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'auto:prod');
});
