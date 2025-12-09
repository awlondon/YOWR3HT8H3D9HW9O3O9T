import test from 'node:test';
import assert from 'node:assert/strict';
import { runHlsfReasoning } from '../hlsfReasoner.js';
import type { ThoughtEvent } from '../cognitionTypes.js';

test('runHlsfReasoning emits thought events and articulates a response for introductions', async () => {
  const prompt = 'I am the first person you interact with here. My name is Altair. Nice to meet you.';
  const thoughts: ThoughtEvent[] = [];

  const result = await runHlsfReasoning(prompt, {
    onThought: ev => thoughts.push(ev),
  });

  assert.equal(thoughts.length > 0, true, 'expected at least one ThoughtEvent');
  assert.equal(result.trace.some(entry => entry.toLowerCase().includes('cluster')), true);
  assert.equal(/altair/i.test(result.response), true);
});
