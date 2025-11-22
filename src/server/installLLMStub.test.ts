import test from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeStubContent, extractPrompt } from './installLLMStub.js';

test('synthesizeStubContent highlights rotation narratives when provided', () => {
  const content = [
    'Rotation narrative',
    'Horizontal axis shear: 1. reflect → on 2. previews → prompt 3. focus → the 4. answer → and',
    'Longitudinal axis torsion: 1. summarize → emergent 2. insights → reference 3. Latent Field 2 → work',
    'Sagittal axis resonance: 1. describe → intersections 2. crossing → summarize',
  ].join('\n');
  const result = synthesizeStubContent([{ role: 'user', content }]);
  assert.strictEqual(/Horizontal axis intersections: reflect → on; previews → prompt; focus → the\./.test(result), true);
  assert.strictEqual(/Sagittal axis intersections: describe → intersections; crossing → summarize\./.test(result), true);
});

test('synthesizeStubContent handles prefixed axis markers and dedupes overlaps', () => {
  const content = [
    'Rotation 1 Horizontal axis shear reflect → on previews → prompt',
    'Rotation 2 Horizontal axis shear reflect → on previews → prompt',
    'Rotation 3 Sagittal axis resonance intersections discovered → summarized',
  ].join('\n');
  const result = synthesizeStubContent([{ role: 'user', content }]);
  assert.strictEqual(/Horizontal axis intersections: shear reflect → on previews → prompt\./.test(result), true);
  assert.strictEqual(/Sagittal axis intersections: (?:resonance\s+)?intersections discovered → summarized\./.test(result), true);
});

test('extractPrompt prefers explicit user intent over reference answers', () => {
  const content = [
    'Reflect on the previous visible answer using HLSF rotations. Rotate sequentially through all axes.',
    'Reference answer: [offline stub] integrating rotation previews. Prompt focus: [offline stub] repeating text.',
  ].join('\n');
  assert.equal(
    extractPrompt(content),
    'Reflect on the previous visible answer using HLSF rotations. Rotate sequentially through all axes.'
  );
});
