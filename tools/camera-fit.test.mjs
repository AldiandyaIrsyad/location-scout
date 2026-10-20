import assert from 'node:assert/strict';
import test from 'node:test';
import { fitBounds, viewDepthRange } from '../web/js/camera-fit.js';

function projectedCorners(bounds, settings, pose) {
  const sy = Math.sin(pose.yaw), cy = Math.cos(pose.yaw);
  const sp = Math.sin(pose.pitch), cp = Math.cos(pose.pitch);
  const right = [cy, 0, sy], up = [-sy * sp, cp, cy * sp], forward = [sy * cp, sp, -cy * cp];
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const tanV = Math.tan(settings.fov * Math.PI / 360);
  const out = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) {
    for (const z of [bounds.min[2], bounds.max[2]]) {
      const d = [x - pose.target[0], y - pose.target[1], z - pose.target[2]];
      const depth = pose.distance + dot(d, forward);
      out.push({ x: dot(d, right) / (depth * tanV * settings.aspect), y: dot(d, up) / (depth * tanV), depth });
    }
  }
  return out;
}

for (const aspect of [0.55, 1, 2.55]) for (const height of [20, 330, 828]) {
  test(`fits ${height}m scene at aspect ${aspect}`, () => {
    const bounds = { min: [-150, -12, -150], max: [150, height, 150] };
    const settings = { fov: 41.112, aspect };
    const pose = fitBounds(bounds, settings);
    const radius = Math.hypot(...bounds.min.map((v, i) => bounds.max[i] - v)) / 2;
    const range = viewDepthRange(pose.distance, radius);
    for (const p of projectedCorners(bounds, settings, pose)) {
      assert.ok(p.depth > range.near, 'every corner must survive the near clipping plane');
      assert.ok(p.depth < range.far && p.depth < range.fogNear, 'framed geometry must survive depth clipping and fog');
      assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1, 'every corner must fit in the viewport');
    }
  });
}

test('top view fits on a narrow display and leaves the input bounds intact', () => {
  const bounds = { min: [-300, -40, -200], max: [300, 554.5, 200] };
  const original = structuredClone(bounds);
  const settings = { fov: 32, aspect: 0.6, yaw: 0, pitch: -Math.PI / 2 + 0.001 };
  const pose = fitBounds(bounds, settings);
  for (const p of projectedCorners(bounds, settings, pose)) assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1);
  assert.deepEqual(bounds, original);
});
