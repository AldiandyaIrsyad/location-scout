import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { LITTER_CHOICES, LITTER_PALETTES, litterColour, litterCount, litterKind, litterScatter, litterShape } from '../web/js/litter.js';

const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('kind: a chosen palette wins; auto follows the season and is nothing in winter', () => {
  assert.deepEqual(['autumn', 'spring', 'summer', 'winter', 'nonsense', undefined].map((s) => litterKind('auto', s)), ['autumn', 'petals', 'green', null, null, null]);
  assert.equal(litterKind('petals', 'autumn'), 'petals');
  assert.equal(litterKind('green', 'winter'), 'green', 'chosen even in winter');
  assert.equal(litterKind('toString', 'autumn'), 'autumn');
});

test('count: scales with density, varies with u, clamps, bad input is none', () => {
  assert.equal(litterCount(0, 0.5), 0);
  assert.equal(litterCount('x', 0.5), 0);
  assert.equal(litterCount(100, 0.5), 14);
  assert.equal(litterCount(50, 0.5), 7);
  assert.ok(litterCount(100, 1) > litterCount(100, 0));
  assert.equal(litterCount(900, 0.5), 14);
  assert.equal(litterCount(100, 9), litterCount(100, 1));
});

test('colour: every colour of a palette is reachable and an unknown palette gives autumn', () => {
  for (const [name, set] of Object.entries(LITTER_PALETTES)) {
    assert.equal(new Set(Array.from({ length: 50 }, (_, i) => litterColour(name, i / 50))).size, set.length, name);
  }
  assert.equal(litterColour('toString', 0), LITTER_PALETTES.autumn[0]);
  assert.equal(litterColour('autumn', 7), LITTER_PALETTES.autumn.at(-1));
});

test('scatter: the right number of pieces, all within the radius, and denser near the trunk than a uniform disc', () => {
  assert.equal(litterScatter(0, 3, seq([0.5])).length, 0);
  assert.equal(litterScatter(-4, 3, seq([0.5])).length, 0);
  let s = 12345;
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pieces = litterScatter(4000, 3, rand);
  assert.equal(pieces.length, 4000);
  assert.ok(pieces.every((p) => Math.hypot(p.dx, p.dy) <= 3 + 1e-9 && p.k >= 0.7 && p.k <= 1.3 && p.rot >= 0 && p.rot <= Math.PI));
  const inner = pieces.filter((p) => Math.hypot(p.dx, p.dy) < 1.5).length / pieces.length;
  assert.ok(inner > 0.3, `${inner} within half the radius (a uniform disc gives 0.25)`);
});

test('shape: a diamond longer than wide, centred on the origin, that scales with size and turns with rot', () => {
  const a = litterShape(1, 1, 0);
  assert.equal(a.length, 4);
  assert.ok(Math.abs(a[0][0] + a[2][0]) < 1e-12 && Math.abs(a[1][1] + a[3][1]) < 1e-12, 'centred');
  assert.ok(a[0][0] > a[1][1] * 1.5, 'long axis along x');
  const big = litterShape(2, 1, 0);
  assert.ok(Math.abs(big[0][0] / a[0][0] - 2) < 1e-9);
  assert.deepEqual(litterShape(99, 1, 0), litterShape(3, 1, 0));
  const turned = litterShape(1, 1, Math.PI / 2);
  assert.ok(Math.abs(turned[0][0]) < 1e-12 && Math.abs(turned[0][1] - a[0][0]) < 1e-12);
  const len = (p) => Math.hypot(p[0][0] - p[2][0], p[0][1] - p[2][1]);
  assert.ok(Math.abs(len(turned) - len(a)) < 1e-12, 'turning keeps the size');
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wLitterColour">(.*?)<\/select>/s);
  assert.ok(m, '#wLitterColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), LITTER_CHOICES);
});
