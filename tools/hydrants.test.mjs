import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { HYDRANT_CHOICES, HYDRANT_COLOURS, hydrantChance, hydrantColour, hydrantParts, hydrantSpacing } from '../web/js/hydrants.js';

const nyc = { lat: 40.7, lon: -74 };
const tokyo = { lat: 35.66, lon: 139.7 };
const paris = { lat: 48.86, lon: 2.29 };
const seoul = { lat: 37.56, lon: 126.98 };

test('spacing: North America has many, Europe some, Japan and Korea few', () => {
  const [n, p, t, s] = [nyc, paris, tokyo, seoul].map(hydrantSpacing);
  assert.ok(n < p && p < t);
  assert.equal(t, s);
  assert.equal(hydrantSpacing(null), p);
});

test('chance: percentage per sample, clamped, bad input is none', () => {
  assert.equal(hydrantChance(100, 50, 10), 0.2);
  assert.equal(hydrantChance(0, 50, 10), 0);
  assert.equal(hydrantChance(100, 5, 10), 1);
  assert.equal(hydrantChance(900, 50, 10), 0.2);
  assert.equal(hydrantChance('x', 50, 10), 0);
});

test('colour: red in North America and Japan, yellow elsewhere; a chosen one wins', () => {
  assert.deepEqual([nyc, tokyo, paris, null].map((c) => hydrantColour('auto', c)), [HYDRANT_COLOURS.red, HYDRANT_COLOURS.red, HYDRANT_COLOURS.yellow, HYDRANT_COLOURS.yellow]);
  assert.equal(hydrantColour('blue', nyc), HYDRANT_COLOURS.blue);
  assert.equal(hydrantColour('toString', paris), HYDRANT_COLOURS.yellow);
});

test('the hydrant stacks foot, body, cap and top without gaps, with nozzles on the body and the big one facing the street', () => {
  const p = hydrantParts(1);
  assert.equal(p.cyls[0].h0, 0);
  for (let i = 1; i < p.cyls.length; i++) assert.ok(Math.abs(p.cyls[i].h0 - p.cyls[i - 1].h1) < 1e-12, `ring ${i} sits on the one below`);
  const body = p.cyls[1];
  const nozzles = p.boxes.filter((b) => b.h0 > body.h0 && b.h1 < body.h1);
  assert.equal(nozzles.length, 3);
  const [left, right, big] = nozzles;
  assert.ok(left.u1 < 0 && right.u0 > 0, 'side nozzles either side of the body');
  assert.ok(left.u0 < -body.r && right.u1 > body.r, 'they stick out past the body');
  assert.ok(big.v1 > body.r && big.v0 > 0, 'the big nozzle points towards the street (+v)');
  const top = Math.max(...p.cyls.map((c) => c.h1), ...p.boxes.map((b) => b.h1));
  assert.ok(top > 0.65 && top < 0.85, `${top} m tall`);
  for (const b of p.boxes) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
});

test('size scales everything and clamps to 0.7..1.5', () => {
  const a = hydrantParts(1);
  const b = hydrantParts(1.5);
  assert.ok(Math.abs(b.cyls[1].r / a.cyls[1].r - 1.5) < 1e-9);
  assert.ok(Math.abs(b.boxes[2].v1 / a.boxes[2].v1 - 1.5) < 1e-9);
  assert.deepEqual(hydrantParts(9), b);
  assert.deepEqual(hydrantParts(0), a);
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wHydrantColour">(.*?)<\/select>/s);
  assert.ok(m, '#wHydrantColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), HYDRANT_CHOICES);
});
