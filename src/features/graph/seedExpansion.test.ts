import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSeed } from './seedExpansion.js';
import { AdjacencyFamily, classifyRelation } from '../../types/adjacencyFamilies.js';

test('expandSeed builds triangular lattice for n=8', () => {
  const result = expandSeed('concept-0', 8, 'Concept', 1);
  assert.equal(result.triangles.length, 3, 'expected three triangles for n=8');
  assert.equal(result.nodes.length, 4, 'emergent nodes should chain across triangles');
  assert.equal(result.edges.length, 7, 'seed lattice uses shared anchors and lateral edges');

  const edgeTargets = new Set(result.edges.map(edge => edge.target));
  assert.ok(edgeTargets.has('concept-0:seed:0'));
  assert.ok(edgeTargets.has('concept-0:seed:3'));
});

test('seed-expansion edges carry operational adjacency family', () => {
  const result = expandSeed('concept-1', 8, 'Concept', 2);
  const families = new Set(result.edges.map(edge => edge.family));
  assert.deepEqual(families, new Set([AdjacencyFamily.Operational]));
  assert.equal(classifyRelation('seed-expansion'), AdjacencyFamily.Operational);
});
