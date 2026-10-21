import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { AC_TONES, acChance, acParts, acSpacing, acTone, gapCentre, unitHeights } from '../web/js/acunits.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };
const nyc = { lat: 40.7, lon: -74 };

test('spacing by place: Asian blocks are covered in units, Paris has few; Korea is not mistaken for Japan', () => {
  assert.deepEqual([tokyo, seoul, jakarta, paris, nyc, null].map(acSpacing), [8, 9, 7, 40, 24, 24]);
});

test('chance scales with density and clamps', () => {
  assert.equal(acChance(100, 20, 10), 0.5);
  assert.equal(acChance(0, 20, 10), 0);
  assert.equal(acChance(100, 5, 10), 1);
  assert.equal(acChance(800, 20, 10), 0.5);
  assert.equal(acChance('x', 20, 10), 0);
});

test('tone: a chosen one wins, mixed and unknown choices cover the palette by u', () => {
  assert.equal(acTone('cream', 0), AC_TONES.cream);
  assert.equal(acTone('toString', 0), AC_TONES.white, 'an inherited name is not a tone');
  assert.equal(new Set([0, 0.3, 0.6, 0.99].map((u) => acTone('mixed', u))).size, 4);
  assert.equal(acTone('mixed', 1), acTone('mixed', 0.99));
});

test('gaps between window columns lie on multiples of 3 m, on both sides of zero', () => {
  assert.equal(gapCentre(0.4), 0);
  assert.equal(gapCentre(1.6), 3);
  assert.equal(gapCentre(4.4), 3);
  assert.equal(gapCentre(-1.4), 0);
  assert.equal(gapCentre(-1.6), -3);
});

test('unit heights: mid-window of rows above the ground floor, under the roof, measured from the wall ground', () => {
  const all = unitHeights(0, 20, () => 0, 1);
  assert.ok(all.length >= 4);
  for (const h of all) {
    assert.ok(Math.abs(((h - 1.0) / 3.2) - Math.round((h - 1.0) / 3.2)) < 1e-9, 'on the 3.2 m row grid, 1 m above the floor line');
    assert.ok(h >= 2.4 && h + 0.6 <= 20 - 0.4);
  }
  assert.ok(all[0] >= 2.4 && all[0] < 2.4 + 3.2, 'the lowest unit is on the first upper row');
  assert.deepEqual(unitHeights(0, 4, () => 0, 1), [], 'no room on a low building');
  assert.deepEqual(unitHeights(0, 20, () => 0.9, 0.5), [], 'the share decides each row');
  const hill = unitHeights(50, 15, () => 0, 1);
  assert.ok(hill.every((h) => h >= 52.4 && h + 0.6 <= 64.6));
  assert.ok(hill.every((h) => Math.abs(((h - 1.0) / 3.2) - Math.round((h - 1.0) / 3.2)) < 1e-9), 'still on the world grid');
});

test('a unit is a casing with a dark grille on its front, two brackets on the wall and a pipe, scaling with size', () => {
  const p = acParts(1);
  assert.deepEqual(p.map((b) => b.role), ['casing', 'grille', 'bracket', 'bracket', 'pipe']);
  for (const b of p) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
  const casing = p[0];
  assert.ok(p[1].v0 >= casing.v1 - 1e-9, 'the grille is in front of the casing');
  assert.ok(p[2].v1 <= casing.v0 + 1e-9, 'brackets are against the wall');
  assert.ok(casing.u1 - casing.u0 < 1.4, 'fits in the 1.4 m gap between windows');
  const big = acParts(1.5);
  assert.ok(Math.abs((big[0].u1 - big[0].u0) / (casing.u1 - casing.u0) - 1.5) < 1e-9);
  assert.deepEqual(acParts(9), acParts(1.6), 'size clamps');
  assert.deepEqual(acParts(0), acParts(1), 'zero or junk counts as 1');
});

test('the tone options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wAcTone">(.*?)<\/select>/s);
  assert.ok(m, '#wAcTone exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['mixed', ...Object.keys(AC_TONES)]);
});
