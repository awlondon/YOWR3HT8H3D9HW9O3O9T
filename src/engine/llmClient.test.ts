import test from 'node:test';
import assert from 'node:assert/strict';

import { callLLM, resolveEndpoint } from './llm/client.js';

const baseContext = {
  hub: 'hub',
  neighbors: ['a', 'b'],
  activeContexts: ['x'],
  rotationNotes: 'notes',
  graphStats: { depth: 1, nodes: 2, branches: 1 },
};

function makeRequest(overrides: Partial<Parameters<typeof callLLM>[0]> = {}) {
  return {
    prompt: 'test prompt',
    context: baseContext,
    ...overrides,
  } as any;
}

test('resolveEndpoint enforces absolute URL on file protocol', () => {
  const original = globalThis.window;
  (globalThis as any).window = { location: { protocol: 'file:' } } as any;
  try {
    assert.throws(() => resolveEndpoint(), /absolute/);
  } finally {
    (globalThis as any).window = original as any;
  }
});

test('callLLM retries once on transient errors', async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    callCount += 1;
    if (callCount === 1) {
      return new Response('error', { status: 502, headers: { 'Content-Type': 'text/plain' } });
    }
    const responsePayload = {
      emergent_trace: ['used neighbors'],
      structured_response: 'Structured Response: ' + Array.from({ length: 50 }).map(() => 'ok').join(' '),
    };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await callLLM(makeRequest(), { fetchImpl });

  assert.equal(callCount, 2);
  assert.equal(result.structured_response?.includes('Structured Response'), true);
});

test('callLLM enforces timeout and surfaces abort errors', async () => {
  const fetchImpl: typeof fetch = (_url, init) =>
    new Promise<Response>((_, reject) => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      init?.signal?.addEventListener('abort', () => reject(abortError));
    });

  await (assert as any).rejects(
    () => callLLM(makeRequest(), { fetchImpl, timeoutMs: 10 }),
    /timeout/i,
  );
});

test('callLLM flags length violations and attempts compression/expansion', async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    callCount += 1;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const shouldCompress = typeof body?.mode === 'string' && body.mode === 'compress';
    const shouldExpand = typeof body?.mode === 'string' && body.mode === 'expand';
    const word = 'word';
    const responseText = shouldCompress
      ? 'Structured Response: ' + Array.from({ length: 40 }).map(() => word).join(' ')
      : shouldExpand
        ? 'Structured Response: ' + Array.from({ length: 60 }).map(() => word).join(' ')
        : 'Structured Response: ' + Array.from({ length: 320 }).map(() => word).join(' ');
    const payload = { structured_response: responseText, emergent_trace: 'trace' };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await callLLM(makeRequest(), { fetchImpl });

  assert.equal(callCount >= 2, true);
  const wordCount = result.structured_response?.split(/\s+/).filter(Boolean).length ?? 0;
  assert.equal(wordCount <= 300 && wordCount >= 30, true);
  assert.equal(result.lengthStatus === 'length_violation' || result.lengthStatus === 'ok', true);
});

test('rejects unexpected non-JSON/plain text responses', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });

  await (assert as any).rejects(
    () => callLLM(makeRequest(), { fetchImpl }),
    /Unexpected response format/i,
  );
});
