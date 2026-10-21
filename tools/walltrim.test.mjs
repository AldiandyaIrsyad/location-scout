import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TRIM_CHOICES, TRIM_TONES, hasTrim, outwardStrips, trimBands, trimDepth, trimTone } from '../web/js/walltrim.js';

test('share is a percentage of buildings, clamped, and bad input is none', () => {
  const draws = Array.from({ length: 100 }, (_, i) => i / 100);
  assert.equal(draws.filter((u) => hasTrim(0, u)).length, 0);
  assert.equal(draws.filter((u) => hasTrim(100, u)).length, 100);
  assert.equal(draws.filter((u) => hasTrim(40, u)).length, 40);
  assert.equal(hasTrim(900, 0.99), true);
  assert.equal(hasTrim('x', 0), false);
});

test('tone: each choice has its multiplier, light is brighter than dark, unknown counts as light', () => {
  assert.ok(trimTone('light') > trimTone('same') && trimTone('same') > trimTone('dark'));
  assert.equal(trimTone('toString'), TRIM_TONES.light);
  assert.equal(trimTone(undefined), TRIM_TONES.light);
});

test('depth clamps to 0.02..0.25 and falls back to 7 cm', () => {
  assert.equal(trimDepth(0), 0.02);
  assert.equal(trimDepth(5), 0.25);
  assert.equal(trimDepth('x'), 0.07);
  assert.equal(trimDepth(0.1), 0.1);
});

test('floor bands sit mid-gap between window rows whatever the ground level, never on a window', () => {
  for (const ground of [0, 0.8, 2.9, 35.5, 118.2]) {
    const bands = trimBands(ground, ground + 20, 0.07, ground).filter((b) => b.role === 'floor');
    assert.ok(bands.length >= 4, `${ground}: ${bands.length} floor lines in 20 m`);
    for (const b of bands) {
      const rel = ((b.h0 + b.h1) / 2 - 3.25) / 3.2;
      assert.ok(Math.abs(rel - Math.round(rel)) < 1e-9, `${ground}: ${b.h0} is mid-gap`);
      const inRow = ((b.h0 % 3.2) + 3.2) % 3.2;
      assert.ok(inRow > 2.5 && inRow + (b.h1 - b.h0) < 4.0, 'inside the 2.5..4.0 gap');
      assert.ok(b.h0 > ground + 2.2, 'above head height');
    }
    for (let i = 1; i < bands.length; i++) assert.ok(Math.abs(bands[i].h0 - bands[i - 1].h0 - 3.2) < 1e-9, 'one per floor');
  }
});

test('plinth on the ground, cornice (two steps, the upper one deeper) under the roof, nothing overlaps or pokes above the wall', () => {
  const bands = trimBands(10, 30, 0.1, 10.4);
  const by = (role) => bands.filter((b) => b.role === role);
  assert.equal(by('plinth').length, 1);
  assert.equal(by('plinth')[0].h0, 10, 'starts at the wall foot');
  assert.ok(by('plinth')[0].h1 > 10.4);
  const [low, high] = by('cornice');
  assert.ok(high.out > low.out && high.h0 >= low.h1 - 1e-12 && high.h1 === 30);
  for (const b of bands) assert.ok(b.h0 < b.h1 && b.h1 <= 30 && b.out > 0);
  for (const f of by('floor')) assert.ok(f.h1 <= low.h0 - 0.2, 'string courses stay clear of the cornice');
});

test('low walls: nothing under 2.2 m, a plinth only under 3.5 m, no string course below the first window gap', () => {
  assert.deepEqual(trimBands(0, 2, 0.07), []);
  const low = trimBands(0, 3, 0.07);
  assert.deepEqual(low.map((b) => b.role), ['plinth']);
  const two = trimBands(0, 7, 0.07);
  assert.ok(two.some((b) => b.role === 'cornice') && two.filter((b) => b.role === 'floor').length === 1);
});

test('depth scales the projection of every band', () => {
  const a = trimBands(0, 12, 0.05);
  const b = trimBands(0, 12, 0.1);
  assert.equal(a.length, b.length);
  a.forEach((x, i) => assert.ok(Math.abs(b[i].out / x.out - 2) < 1e-9));
});

test('the tone options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wTrimTone">(.*?)<\/select>/s);
  assert.ok(m, '#wTrimTone exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), TRIM_CHOICES);
});

const inQuad = (q, [x, y]) => {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
};
const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

test('outward strips lie outside the footprint for either winding, and meet at every corner', () => {
  for (const ring of [square, [...square].reverse()]) {
    const strips = outwardStrips(ring, 0.2);
    assert.equal(strips.length, 4);
    for (const q of strips) {
      // the two far corners are beyond the wall, the two near corners on its line (extended by 0.2 along it)
      const outside = q.filter(([x, y]) => x < -1e-9 || x > 10 + 1e-9 || y < -1e-9 || y > 10 + 1e-9);
      assert.ok(outside.length >= 2, 'the strip is outside the wall');
    }
    for (const [cx, cy] of [[0, 0], [10, 0], [10, 10], [0, 10]]) {
      const dx = cx === 0 ? -0.1 : 0.1;
      const dy = cy === 0 ? -0.1 : 0.1;
      assert.ok(strips.some((q) => inQuad(q, [cx + dx, cy + dy])), `the corner (${cx}, ${cy}) is covered`);
    }
    assert.ok(!strips.some((q) => inQuad(q, [5, 5])), 'the middle of the building is clear');
  }
});

test('outward strips skip very short edges and scale with the width', () => {
  assert.equal(outwardStrips([[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]], 0.2).length, 0);
  const wide = outwardStrips(square, 0.4)[0];
  const thin = outwardStrips(square, 0.2)[0];
  const depth = (q) => Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
  assert.ok(Math.abs(depth(wide) / depth(thin) - 2) < 1e-9);
});
