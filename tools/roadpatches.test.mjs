import assert from 'node:assert/strict';
import test from 'node:test';
import { PUDDLE_SPACING, crackPoints, patchChance, patchPolygon, patchShade, patchSize, puddleChance, puddlePolygon, puddleSize, wetDarkening } from '../web/js/roadpatches.js';

const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
const area = (pts) => Math.abs(pts.reduce((t, p, i) => { const q = pts[(i + 1) % pts.length]; return t + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

test('chance scales with density and clamps', () => {
  assert.equal(patchChance(100, 40, 8), 0.2);
  assert.equal(patchChance(0, 40, 8), 0);
  assert.equal(patchChance(100, 4, 8), 1);
  assert.equal(patchChance(999, 40, 8), 0.2);
  assert.equal(patchChance('x', 40, 8), 0);
});

test('a patch is a four-cornered shape near the asked size, never degenerate', () => {
  const flat = patchPolygon(() => 0.5, 2, 3);
  assert.deepEqual(flat, [[-1, -1.5], [1, -1.5], [1, 1.5], [-1, 1.5]], 'no jitter is the plain rectangle');
  for (const r of [() => 0, () => 1, seq(0, 1, 0.3, 0.9)]) {
    const p = patchPolygon(r, 2, 3);
    assert.equal(p.length, 4);
    assert.ok(area(p) > 6 * 0.6 && area(p) < 6 * 1.4, `area ${area(p)} stays near 6`);
    assert.ok(p.every(([x, y]) => Math.abs(x) <= 1.13 && Math.abs(y) <= 1.7), 'corners stay within 12% of the rectangle');
  }
});

test('a crack runs the asked length along y, in equal steps, wandering sideways but staying narrow', () => {
  const c = crackPoints(seq(1, 0, 1, 1, 0), 2, 0.14, 0.4);
  assert.equal(c.length, 6);
  assert.deepEqual(c[0], [0, 0]);
  assert.ok(Math.abs(c[5][1] - 2) < 1e-9);
  assert.ok(c.every((p, i) => i === 0 || Math.abs(p[1] - c[i - 1][1] - 0.4) < 1e-9), 'equal steps');
  assert.ok(c.every((p, i) => i === 0 || Math.abs(p[0] - c[i - 1][0]) <= 0.14 + 1e-9), 'each step wanders at most `wander`');
  const wild = crackPoints(() => 1, 20, 0.4, 0.4);
  assert.ok(wild.every((p) => Math.abs(p[0]) <= 0.5), 'never strays more than half a metre');
  assert.equal(crackPoints(() => 0.5, 0.1).length, 2, 'at least two points');
  assert.ok(crackPoints(() => 0.5, 3, 0.14, 0.4).every((p) => p[0] === 0), 'a steady stream gives a straight line');
});

test('patch size comes from its ranges and the size multiplier, which clamps', () => {
  assert.deepEqual(patchSize(0, 0, 1), { w: 0.9, d: 1.2 });
  const big = patchSize(1, 1, 1);
  assert.ok(Math.abs(big.w - 2.8) < 1e-9 && Math.abs(big.d - 3.6) < 1e-9);
  assert.deepEqual(patchSize(0, 0, 2), { w: 1.8, d: 2.4 });
  assert.deepEqual(patchSize(0, 0, 50), patchSize(0, 0, 2), 'size clamps at 2');
  assert.deepEqual(patchSize(0, 0, 0), patchSize(0, 0, 1), 'zero or junk counts as 1');
  assert.deepEqual(patchSize(-3, 9, 1), patchSize(0, 1, 1), 'u and v clamp');
});

test('most patches are fresh dark asphalt, the rest old pale repairs', () => {
  assert.equal(patchShade(0), 0.8);
  assert.equal(patchShade(0.64), 0.8);
  assert.equal(patchShade(0.65), 1.14);
  assert.equal(patchShade(1), 1.14);
});

test('no puddles until the street is clearly wet, then the rate rises to its full value at 100%', () => {
  assert.equal(puddleChance(0, 8), 0);
  assert.equal(puddleChance(14, 8), 0, 'merely damp');
  assert.equal(puddleChance(15, 8), 0, 'the rate starts from zero at the threshold');
  assert.ok(puddleChance(50, 8) > 0 && puddleChance(50, 8) < puddleChance(100, 8));
  assert.equal(puddleChance(100, 8), 8 / PUDDLE_SPACING);
  assert.equal(puddleChance(900, 8), puddleChance(100, 8), 'clamps at 100');
  assert.equal(puddleChance('x', 8), 0);
  assert.equal(puddleChance(100, 99), 1, 'never above certainty');
});

test('a puddle is a ten-point rounded blob near the asked size', () => {
  const flat = puddlePolygon(() => 0.5, 2, 1);
  assert.equal(flat.length, 10);
  assert.ok(Math.abs(flat[0][0] - 1) < 1e-9 && Math.abs(flat[0][1]) < 1e-9, 'no jitter is the plain ellipse');
  for (const r of [() => 0, () => 1, seq(0, 1, 0.5)]) {
    const p = puddlePolygon(r, 2, 1);
    assert.ok(p.every(([x, y]) => Math.abs(x) <= 1.22 && Math.abs(y) <= 0.62));
    assert.ok(area(p) > 0.5 * Math.PI * 0.5, 'never collapses');
  }
});

test('puddle size comes from its ranges and the clamped size multiplier', () => {
  assert.deepEqual(puddleSize(0, 0, 1), { w: 0.8, d: 0.6 });
  const big = puddleSize(1, 1, 1);
  assert.ok(Math.abs(big.w - 2.4) < 1e-9 && Math.abs(big.d - 1.6) < 1e-9);
  assert.deepEqual(puddleSize(0, 0, 50), puddleSize(0, 0, 2));
  assert.deepEqual(puddleSize(0, 0, 0), puddleSize(0, 0, 1));
});

test('wet darkening is proportional and clamped', () => {
  assert.equal(wetDarkening(0), 0);
  assert.ok(Math.abs(wetDarkening(50) - 0.15) < 1e-12);
  assert.ok(Math.abs(wetDarkening(100) - 0.3) < 1e-12);
  assert.equal(wetDarkening(400), wetDarkening(100));
  assert.equal(wetDarkening(-5), 0);
  assert.equal(wetDarkening('x'), 0);
});
