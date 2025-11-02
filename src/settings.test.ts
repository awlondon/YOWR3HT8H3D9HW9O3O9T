import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePerformanceProfile, PERFORMANCE_PROFILES } from './settings.js';

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
