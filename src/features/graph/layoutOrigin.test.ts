import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distributeAngles,
  getCornerPivot,
  getInwardWedgeAngles,
  resolveOriginPadding,
} from './layoutOrigin.js';

test('corner pivot respects padding and corner selection', () => {
  const padding = resolveOriginPadding(50, 12);
  const pivot = getCornerPivot(1000, 800, 'bottom-left', padding);
  const enlargedPadding = resolveOriginPadding(20, 80);

  assert.equal(padding, 50);
  assert.equal(enlargedPadding, 88);
  assert.equal(pivot.x, 50);
  assert.equal(pivot.y, 800 - 50);
});

test('inward wedge aims toward screen center', () => {
  const pivot = { x: 50, y: 750 };
  const wedge = getInwardWedgeAngles(pivot, 1000, 800, Math.PI / 2);
  const centerTheta = Math.atan2(400 - 750, 500 - 50);
  const expectedStart = centerTheta - Math.PI / 4;
  const expectedEnd = centerTheta + Math.PI / 4;

  assert.equal(Math.abs(wedge.start - expectedStart) < 1e-6, true);
  assert.equal(Math.abs(wedge.end - expectedEnd) < 1e-6, true);
});

test('wedge distributes angles inward for fanout', () => {
  const pivot = { x: 50, y: 750 };
  const wedge = getInwardWedgeAngles(pivot, 1000, 800, Math.PI / 2);
  const angles = distributeAngles(4, wedge);
  const radius = 140;
  const positions = angles.map((theta) => ({
    x: pivot.x + radius * Math.cos(theta),
    y: pivot.y + radius * Math.sin(theta),
  }));

  assert.equal(angles.length, 4);
  positions.forEach((p) => {
    assert.equal(p.x >= pivot.x - 1e-6, true, 'x should move rightward/inward');
    assert.equal(p.y <= pivot.y + 1e-6, true, 'y should trend upward from bottom-left');
  });
});
