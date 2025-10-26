import test from 'node:test';
import assert from 'node:assert/strict';
import { computeModelParameters, MODEL_PARAM_DEFAULTS } from './modelParams.js';

test('computeModelParameters counts only node embeddings when other components disabled', () => {
  const stats = {
    graph_nodes: 10,
    anchors: 4,
    edge_types_enumerated: 0,
    total_relationships: 0,
  };
  const config = {
    ...MODEL_PARAM_DEFAULTS,
    D: 16,
    levels: 0,
    last_level_components: 0,
    learn_anchor_embeddings: 'none' as const,
    learn_edge_scalars: 0 as const,
    relation_param_mode: 'none' as const,
    per_level_transform: 'none' as const,
    include_bias_in_transforms: false,
    head: 'mlp:none' as const,
  };
  const result = computeModelParameters(stats, config);
  assert.equal(result.components.node_embeddings, 160);
  assert.equal(result.total_parameters, 160);
});

test('computeModelParameters adds separate anchor embeddings when requested', () => {
  const stats = {
    graph_nodes: 5,
    anchors: 2,
    edge_types_enumerated: 0,
    total_relationships: 0,
  };
  const config = {
    ...MODEL_PARAM_DEFAULTS,
    D: 12,
    levels: 0,
    last_level_components: 0,
    learn_anchor_embeddings: 'separate' as const,
    learn_edge_scalars: 0 as const,
    relation_param_mode: 'none' as const,
    per_level_transform: 'none' as const,
    include_bias_in_transforms: false,
    head: 'mlp:none' as const,
    learn_node_embeddings: true,
  };
  const result = computeModelParameters(stats, config);
  assert.equal(result.components.anchor_embeddings, 24);
  assert.equal(result.total_parameters, result.components.node_embeddings + 24);
});

test('relationship parameters match between type and instance modes when equivalent', () => {
  const stats = {
    graph_nodes: 0,
    anchors: 0,
    edge_types_enumerated: 0,
    total_relationships: 40,
  };
  const typesConfig = {
    ...MODEL_PARAM_DEFAULTS,
    D: 8,
    levels: 0,
    last_level_components: 0,
    learn_node_embeddings: false,
    learn_anchor_embeddings: 'none' as const,
    learn_edge_scalars: 0 as const,
    relation_param_mode: 'types' as const,
    num_relation_types: 5,
    per_level_transform: 'none' as const,
    include_bias_in_transforms: false,
    head: 'mlp:none' as const,
  };
  const instancesConfig = {
    ...typesConfig,
    relation_param_mode: 'instances' as const,
    num_relation_types: undefined,
  };
  const typeResult = computeModelParameters(stats, typesConfig);
  const instanceResult = computeModelParameters(stats, instancesConfig);
  assert.equal(typeResult.components.relationship_params, 40);
  assert.equal(instanceResult.components.relationship_params, 40);
  assert.equal(typeResult.total_parameters, instanceResult.total_parameters);
});

test('level parameter bias toggle adjusts totals by L × D', () => {
  const stats = {
    graph_nodes: 1,
    anchors: 0,
    edge_types_enumerated: 0,
    total_relationships: 0,
  };
  const withBias = {
    ...MODEL_PARAM_DEFAULTS,
    D: 4,
    levels: 3,
    last_level_components: 0,
    learn_node_embeddings: false,
    learn_anchor_embeddings: 'none' as const,
    learn_edge_scalars: 0 as const,
    relation_param_mode: 'none' as const,
    per_level_transform: 'linear' as const,
    include_bias_in_transforms: true,
    head: 'mlp:none' as const,
  };
  const withoutBias = {
    ...withBias,
    include_bias_in_transforms: false,
  };
  const withBiasResult = computeModelParameters(stats, withBias);
  const withoutBiasResult = computeModelParameters(stats, withoutBias);
  assert.equal(
    withBiasResult.components.level_transforms - withoutBiasResult.components.level_transforms,
    12
  );
});

test('model parameter report serializes without data loss', () => {
  const stats = {
    graph_nodes: 8,
    anchors: 6,
    edge_types_enumerated: 12,
    total_relationships: 24,
  };
  const config = {
    ...MODEL_PARAM_DEFAULTS,
    D: 6,
    levels: 2,
    last_level_components: 3,
    learn_anchor_embeddings: 'subset' as const,
    learn_edge_scalars: 1 as const,
    relation_param_mode: 'instances' as const,
    per_level_transform: 'linear' as const,
    include_bias_in_transforms: true,
    head: 'linear' as const,
  };
  const report = computeModelParameters(stats, config);
  const roundTrip = JSON.parse(JSON.stringify(report));
  assert.deepEqual(roundTrip, report);
});
