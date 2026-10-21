import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { LANTERN_CHOICES, LANTERN_TONES, lanternChance, lanternColour, lanternCount, lanternParts, lanternSpacing, norenParts } from '../web/js/lanterns.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };

test('spacing by place: Japan most, then Korea, Indonesia, the rest; Korea is not mistaken for Japan', () => {
  assert.deepEqual([tokyo, seoul, jakarta, paris, null].map(lanternSpacing), [14, 30, 50, 90, 90]);
});

test('chance scales with density and clamps', () => {
  assert.equal(lanternChance(100, 20, 10), 0.5);
  assert.equal(lanternChance(0, 20, 10), 0);
  assert.equal(lanternChance(100, 5, 10), 1);
  assert.equal(lanternChance(300, 20, 10), 0.5);
  assert.equal(lanternChance('x', 20, 10), 0);
});

test('colour: a chosen one wins; mixed (and unknown) is red 70% / white 30%', () => {
  assert.equal(lanternColour('white', 0), LANTERN_TONES.white);
  assert.equal(lanternColour('red', 0.99), LANTERN_TONES.red);
  assert.equal(lanternColour('mixed', 0.69), LANTERN_TONES.red);
  assert.equal(lanternColour('mixed', 0.7), LANTERN_TONES.white);
  assert.equal(lanternColour('toString', 0.9), LANTERN_TONES.white);
});

test('lanterns per door: 1, 2 or 3 by u', () => {
  assert.deepEqual([0, 0.49, 0.5, 0.84, 0.85, 0.999].map(lanternCount), [1, 1, 2, 2, 3, 3]);
});

test('a lantern hangs from its bracket at head height, with a body between a cap and a base and a label on the front', () => {
  const p = lanternParts(1);
  const [cap, base, arm, label] = p.boxes;
  assert.equal(p.boxes.map((b) => b.role).join(), 'dark,dark,arm,label');
  assert.ok(p.blob.h > 2 && p.blob.h < 2.6, 'above head height');
  const top = p.blob.h + p.blob.r * p.blob.sy;
  const bottom = p.blob.h - p.blob.r * p.blob.sy;
  assert.ok(Math.abs(cap.h0 - top) < 1e-9 && Math.abs(base.h1 - bottom) < 1e-9, 'cap on top, base underneath');
  assert.ok(arm.v1 >= cap.v0 && arm.v0 === 0, 'the arm runs from the wall to the cap');
  assert.ok(label.v0 > p.blob.v, 'the label is on the front face of the body');
  for (const b of p.boxes) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
  const big = lanternParts(1.5);
  assert.ok(Math.abs(big.blob.r / p.blob.r - 1.5) < 1e-9);
  assert.deepEqual(lanternParts(9), lanternParts(1.6), 'size clamps');
  assert.deepEqual(lanternParts(0), lanternParts(1), 'zero or junk counts as 1');
});

test('a noren has a rod, equal cloth panels with slits between them, and a pale band on each panel', () => {
  const n = norenParts(1.2, 2.15, 0.7, 3);
  const cloth = n.filter((b) => b.role === 'cloth');
  assert.equal(cloth.length, 3);
  assert.equal(n.filter((b) => b.role === 'band').length, 3);
  assert.equal(n.filter((b) => b.role === 'rod').length, 1);
  const widths = cloth.map((b) => b.u1 - b.u0);
  assert.ok(widths.every((w) => Math.abs(w - widths[0]) < 1e-9), 'equal panels');
  assert.ok(Math.abs(cloth[1].u0 - cloth[0].u1 - 0.04) < 1e-9, 'a slit between panels');
  assert.ok(Math.abs(cloth[0].u0 + 0.6) < 1e-9 && Math.abs(cloth[2].u1 - 0.6) < 1e-9, 'spans the doorway');
  assert.ok(cloth.every((b) => Math.abs(b.h1 - 2.15) < 1e-9 && Math.abs(b.h0 - 1.45) < 1e-9), 'hangs 0.7 from the rod');
  for (const band of n.filter((b) => b.role === 'band')) {
    const owner = cloth.find((c) => band.u0 >= c.u0 && band.u1 <= c.u1);
    assert.ok(owner && band.v0 >= owner.v1 - 1e-9, 'each band lies on the front of its panel');
    assert.ok(band.h0 > owner.h0 && band.h1 < owner.h1);
  }
  assert.equal(norenParts(1.2, 2.15, 0.7, 99).filter((b) => b.role === 'cloth').length, 5, 'at most five panels');
  assert.equal(norenParts(1.2, 2.15, 0.7, 0).filter((b) => b.role === 'cloth').length, 3, 'junk counts as three');
  assert.equal(norenParts(1.2, 2.15, 0.7, 1).filter((b) => b.role === 'cloth').length, 2, 'at least two');
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wLanternColour">(.*?)<\/select>/s);
  assert.ok(m, '#wLanternColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), LANTERN_CHOICES);
});
