import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePerformanceProfile,
  PERFORMANCE_PROFILES,
  resolveAdjacencySettings,
  DEFAULT_ADJACENCY_SETTINGS,
} from './settings.js';

test('resolvePerformanceProfile handles whitespace and casing', () => {
  const profile = resolvePerformanceProfile('  Research  ');
  assert.equal(profile, PERFORMANCE_PROFILES.research);
});

test('resolvePerformanceProfile tolerates punctuation and separators', () => {
  const profile = resolvePerformanceProfile('Chaos-Lab');
  assert.equal(profile, PERFORMANCE_PROFILES.chaoslab);
});

test('resolvePerformanceProfile falls back to balanced when unknown', () => {
  const profile = resolvePerformanceProfile('unknown');
  assert.equal(profile, PERFORMANCE_PROFILES.balanced);
});

test('resolveAdjacencySettings applies defaults when fields missing', () => {
  const resolved = resolveAdjacencySettings();
  assert.deepEqual(resolved, DEFAULT_ADJACENCY_SETTINGS);
});

test('resolveAdjacencySettings clamps invalid values while preserving zero overrides', () => {
  const resolved = resolveAdjacencySettings({
    maxAdjacencyLayers: -2,
    maxAdjacencyDegreePerLayer: [4, -5, 0],
    maxAdjacencyDegree: 0,
    adjacencySimilarityThreshold: 3,
    adjacencyStrongSimilarityThreshold: -1,
  });
  assert.equal(resolved.maxAdjacencyLayers >= 1, true);
  assert.deepEqual(resolved.maxAdjacencyDegreePerLayer.every((value) => value >= 0), true);
  assert.equal(resolved.maxAdjacencyDegree, 0);
  assert.equal(resolved.adjacencySimilarityThreshold >= 0 && resolved.adjacencySimilarityThreshold <= 1, true);
  assert.equal(
    resolved.adjacencyStrongSimilarityThreshold >= resolved.adjacencySimilarityThreshold,
    true,
  );
});

test('resolveAdjacencySettings allows disabling adjacency expansion with zero values', () => {
  const resolved = resolveAdjacencySettings({
    maxAdjacencyLayers: 2,
    maxAdjacencyDegree: 0,
    maxAdjacencyDegreePerLayer: [0, 0],
  });

  assert.deepEqual(resolved.maxAdjacencyDegreePerLayer, [0, 0]);
  assert.equal(resolved.maxAdjacencyDegree, 0);
});
