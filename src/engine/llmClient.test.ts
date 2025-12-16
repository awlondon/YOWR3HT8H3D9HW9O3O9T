import test from 'node:test';
import assert from 'node:assert/strict';

import { callLLM, resolveEndpoint } from './llmClient.js';

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
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const responsePayload = {
      emergent_trace: ['used neighbors'],
      structured_response: 'Structured Response: ok',
    };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await callLLM(
    {
      prompt: 'test prompt',
      messages: [{ role: 'user', content: 'Hello' }],
    },
    { fetchImpl },
  );

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
    () => callLLM({ prompt: 'timeout', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl, timeoutMs: 10 }),
    /timeout/i,
  );
});

test('callLLM flags length violations and attempts compression/expansion', async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    callCount += 1;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const shouldCompress = typeof body?.prompt === 'string' && /Compress the structured response/i.test(body.prompt);
    const word = 'word';
    const responseText = shouldCompress
      ? 'Structured Response: ' + Array.from({ length: 40 }).map(() => word).join(' ')
      : 'Structured Response: ' + Array.from({ length: 320 }).map(() => word).join(' ');
    const payload = { structured_response: responseText, emergent_trace: 'trace' };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await callLLM(
    { prompt: 'lengthy', messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl },
  );

  assert.equal(callCount >= 2, true);
  const wordCount = result.structured_response?.split(/\s+/).filter(Boolean).length ?? 0;
  assert.equal(wordCount <= 300, true);
  assert.equal(result.lengthStatus === 'length_violation' || result.lengthStatus === 'ok', true);
});

test('rejects unexpected non-JSON/plain text responses', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });

  await (assert as any).rejects(
    () => callLLM({ prompt: 'bad format', messages: [{ role: 'user', content: 'ok' }] }, { fetchImpl }),
    /Unexpected response format/i,
  );
});
