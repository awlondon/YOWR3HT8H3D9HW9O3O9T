import test from 'node:test';
import assert from 'node:assert/strict';
import { AdjacencyFamily, classifyRelation } from './adjacencyFamilies.js';

test('classifyRelation maps known relations and falls back to aesthetic', () => {
  assert.equal(classifyRelation('adjacency:base'), AdjacencyFamily.Spatial);
  assert.equal(classifyRelation('modifier:emphasis'), AdjacencyFamily.Communicative);
  assert.equal(classifyRelation('unknown-rel'), AdjacencyFamily.Aesthetic);
});
