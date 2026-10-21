import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { FLOWER_COLOURS, flowerColour, planterChance, planterCount, planterKind, planterParts, planterSpacing, planterWidth } from '../web/js/planters.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

test('spacing by place: Tokyo alleys have the most planters; Korea is not mistaken for Japan', () => {
  assert.deepEqual([tokyo, paris, jakarta, seoul, null].map(planterSpacing), [13, 16, 18, 24, 28]);
});

test('chance scales with density and clamps', () => {
  assert.equal(planterChance(100, 20, 10), 0.5);
  assert.equal(planterChance(0, 20, 10), 0);
  assert.equal(planterChance(100, 5, 10), 1);
  assert.equal(planterChance(700, 20, 10), 0.5);
  assert.equal(planterChance('x', 20, 10), 0);
});

test('flower colour: a chosen one wins, mixed and unknown choices cover the palette', () => {
  assert.equal(flowerColour('red', 0), FLOWER_COLOURS.red);
  assert.equal(flowerColour('toString', 0), FLOWER_COLOURS.pink, 'an inherited name is not a colour');
  assert.equal(new Set([0, 0.2, 0.4, 0.6, 0.99].map((u) => flowerColour('mixed', u))).size, 5);
  assert.equal(flowerColour('mixed', 1), flowerColour('mixed', 0.99));
});

test('kind: a chosen style gives that kind, mixed splits 50 / 30 / 20', () => {
  assert.deepEqual(['pots', 'boxes', 'tubs'].map((s) => planterKind(s, 0.9)), ['pot', 'box', 'tub']);
  assert.deepEqual([0, 0.49, 0.5, 0.79, 0.8, 0.99].map((u) => planterKind('mixed', u)), ['pot', 'pot', 'box', 'box', 'tub', 'tub']);
  assert.equal(planterKind('bogus', 0.9), 'tub');
});

test('count: a window box is always one; pots and tubs run 1 to max, clamped to 1..5', () => {
  assert.equal(planterCount('box', 0.99, 5), 1);
  assert.deepEqual([0, 0.34, 0.67, 0.999].map((u) => planterCount('pot', u, 3)), [1, 2, 3, 3]);
  assert.equal(planterCount('pot', 5, 3), 3, 'u clamps');
  assert.equal(planterCount('pot', 0.9, 99), 5, 'max clamps at 5');
  assert.equal(planterCount('pot', 0.9, 0), 1);
  assert.equal(planterCount('tub', 0.9, 'x'), 1);
  assert.ok(planterWidth('box') > planterWidth('tub') && planterWidth('tub') > planterWidth('pot'));
});

test('every kind stands on the ground with its plants above the soil, and size scales everything', () => {
  for (const kind of ['pot', 'box', 'tub']) {
    const p = planterParts(kind, 1, seq(0.1, 0.5, 0.9, 0.3, 0.7));
    assert.equal(Math.min(...p.boxes.map((b) => b.h0)), 0, `${kind} touches the ground`);
    for (const b of p.boxes) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
    const top = Math.max(...p.boxes.filter((b) => b.role !== 'soil').map((b) => b.h1));
    assert.ok(p.blobs.some((b) => b.role === 'leaf') && p.blobs.some((b) => b.role === 'flower'), `${kind} has leaves and flowers`);
    for (const b of p.blobs) assert.ok(b.h > top * 0.9, `${kind}: plants sit on or above the container (${b.h})`);
    const big = planterParts(kind, 2, seq(0.1, 0.5, 0.9, 0.3, 0.7));
    assert.ok(Math.abs(Math.max(...big.boxes.map((b) => b.h1)) / Math.max(...p.boxes.map((b) => b.h1)) - 2) < 1e-9, 'twice the size');
    assert.ok(Math.abs(big.blobs[0].r / p.blobs[0].r - 2) < 1e-9);
    const clamped = planterParts(kind, 9, seq(0.1, 0.5));
    assert.ok(Math.abs(Math.max(...clamped.boxes.map((b) => b.h1)) - Math.max(...big.boxes.map((b) => b.h1))) < 1e-9, 'size clamps at 2');
    assert.ok(Math.abs(Math.max(...planterParts(kind, 0, seq(0.5)).boxes.map((b) => b.h1)) - Math.max(...p.boxes.map((b) => b.h1))) < 1e-9, 'zero or junk counts as 1');
  }
});

test('a window box is wider than a pot and carries more plants', () => {
  const box = planterParts('box', 1, () => 0.5);
  const pot = planterParts('pot', 1, () => 0.5);
  assert.ok(box.boxes[0].u1 - box.boxes[0].u0 > 2 * (pot.boxes[0].u1 - pot.boxes[0].u0));
  assert.ok(box.blobs.length > pot.blobs.length);
});

test('the colour and style options in the panel match the tables', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const colour = html.match(/id="wPlanterColour">(.*?)<\/select>/s);
  assert.ok(colour, '#wPlanterColour exists');
  assert.deepEqual([...colour[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['mixed', ...Object.keys(FLOWER_COLOURS)]);
  const style = html.match(/id="wPlanterStyle">(.*?)<\/select>/s);
  assert.ok(style, '#wPlanterStyle exists');
  assert.deepEqual([...style[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['mixed', 'pots', 'boxes', 'tubs']);
});
