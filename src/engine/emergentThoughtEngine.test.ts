import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHLSF,
  clusterConcepts,
  composeStructuredResponse,
  decomposePrompt,
  reflectInterconnections,
  refineHLSF,
  runEmergentThoughtProcess,
  traceThoughts,
} from './emergentThoughtEngine.js';

import { type ClusterResult, type StepResult } from './emergentThoughtTypes.js';

test('decomposition keeps tokens and assumptions', () => {
  const input = ['hello', 'world?'];
  const result = decomposePrompt(input);
  assert.equal(result.tokens.length, 2);
  assert.equal(result.assumptions.length, 1);
});

test('clustering groups tokens deterministically', () => {
  const clusters = clusterConcepts({ tokens: ['apple', 'avocado', 'berry'], assumptions: [] });
  assert.equal(clusters.clusters.length >= 1, true);
});

test('HLSF is built from clusters', () => {
  const clusters: ClusterResult = {
    clusters: [
      { id: 'c1', label: 'A', tokens: ['a'], rationale: 'r' },
      { id: 'c2', label: 'B', tokens: ['b'], rationale: 'r' },
    ],
  };
  const hlsf = buildHLSF(clusters);
  assert.equal(hlsf.nodes.length, 2);
  assert.equal(hlsf.edges.length, 1);
});

test('reflection and refinement round-trip', () => {
  const clusters: ClusterResult = {
    clusters: [
      { id: 'c1', label: 'A', tokens: ['a'], rationale: 'r' },
      { id: 'c2', label: 'B', tokens: ['b'], rationale: 'r' },
    ],
  };
  const hlsf = buildHLSF(clusters);
  const reflection = reflectInterconnections(hlsf);
  const refined = refineHLSF(hlsf, reflection);
  assert.equal(refined.edges.length, hlsf.edges.length);
});

test('trace and structured response contain labels', () => {
  const steps: StepResult[] = [
    { step: 1, summary: 'a' },
    { step: 2, summary: 'b' },
  ];
  const trace = traceThoughts(steps);
  const hlsf = buildHLSF({ clusters: [{ id: 'c1', label: 'A', tokens: ['a'], rationale: 'r' }] });
  const structured = composeStructuredResponse(hlsf, trace);
  assert.equal(structured.includes('Emergent Thought Trace'), true);
});

test('runEmergentThoughtProcess orchestrates all steps', async () => {
  const result = await runEmergentThoughtProcess('test prompt for engine');
  assert.equal(result.trace.length > 0, true);
  assert.equal(result.structuredResponse.includes('Structured Response'), true);
});
