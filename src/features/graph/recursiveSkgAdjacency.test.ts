import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecursiveSkgAdjacency,
  dedupNodesByToken,
  type AdjacencyEdge,
  type TokenNode,
} from './recursiveSkgAdjacency.js';
import { AdjacencyFamily, classifyRelation } from '../../types/adjacencyFamilies.js';

const baseNodes: TokenNode[] = [
  { token: 'A', kind: 'word', rawScore: 1, index: 0 },
  { token: 'B', kind: 'word', rawScore: 1, index: 1 },
  { token: 'C', kind: 'word', rawScore: 1, index: 2 },
];

const baseEdges: AdjacencyEdge[] = [
  { source: 'A', target: 'B', type: 'adjacency:base', w: 1, family: classifyRelation('adjacency:base') },
  { source: 'B', target: 'C', type: 'adjacency:base', w: 1, family: classifyRelation('adjacency:base') },
];

test('buildRecursiveSkgAdjacency attaches intermediate nodes and edges', () => {
  const { nodes, edges } = buildRecursiveSkgAdjacency(baseNodes, baseEdges, { depth: 1 });

  assert.ok(nodes.some((node) => node.token === 'A->B'));
  assert.ok(nodes.some((node) => node.token === 'B->C'));

  const skgEdges = edges.filter((edge) => edge.type === 'skg-base');
  assert.equal(skgEdges.length, 4, 'each base edge should yield two SKG connections');
  assert.ok(edges.some((edge) => edge.type === 'skg-cross-level'));

  const families = new Set(edges.map((edge) => edge.family ?? classifyRelation(edge.type)));
  assert.ok(families.has(AdjacencyFamily.Operational), 'SKG edges classified as operational');
});

test('recursive depth 0 preserves the base graph untouched', () => {
  const { nodes, edges } = buildRecursiveSkgAdjacency(baseNodes, baseEdges, { depth: 0 });
  assert.equal(nodes.length, baseNodes.length);
  assert.equal(edges.length, baseEdges.length);
});

test('dedupNodesByToken keeps the first occurrence only', () => {
  const duped: TokenNode[] = [
    { token: 'x', rawScore: 1 },
    { token: 'y', rawScore: 1 },
    { token: 'x', rawScore: 2 },
  ];
  const result = dedupNodesByToken(duped);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.rawScore, 1);
});
