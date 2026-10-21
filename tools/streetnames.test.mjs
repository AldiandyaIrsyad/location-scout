import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PLATE_CHOICES, PLATE_COLOURS, plateChance, plateColour, plateCentre, plateInk, plateParts, plateSize, plateSpacing } from '../web/js/streetnames.js';

const paris = { lat: 48.86, lon: 2.29 };
const tokyo = { lat: 35.66, lon: 139.7 };
const nyc = { lat: 40.7, lon: -74 };
const sydney = { lat: -33.9, lon: 151.2 };

test('spacing: Paris first, then Japan, then everywhere else', () => {
  const s = [paris, tokyo, nyc].map(plateSpacing);
  assert.ok(s[0] < s[1] && s[1] < s[2]);
  assert.equal(plateSpacing(null), s[2]);
});

test('chance: percentage per sample, clamped, bad input is none', () => {
  assert.equal(plateChance(100, 50, 10), 0.2);
  assert.equal(plateChance(0, 50, 10), 0);
  assert.equal(plateChance(100, 5, 10), 1);
  assert.equal(plateChance(900, 50, 10), 0.2);
  assert.equal(plateChance('x', 50, 10), 0);
});

test('colour: auto is blue in France and Japan, green in the Americas, white elsewhere; a chosen colour wins', () => {
  assert.deepEqual([paris, tokyo, nyc, sydney, null].map((c) => plateColour('auto', c)), [PLATE_COLOURS.blue, PLATE_COLOURS.blue, PLATE_COLOURS.green, PLATE_COLOURS.white, PLATE_COLOURS.white]);
  assert.equal(plateColour('black', paris), PLATE_COLOURS.black);
  assert.equal(plateColour('toString', nyc), PLATE_COLOURS.green);
});

test('lettering is light on dark plates and dark on pale ones', () => {
  assert.equal(plateInk(PLATE_COLOURS.blue), '#f3f1e6');
  assert.equal(plateInk(PLATE_COLOURS.black), '#f3f1e6');
  assert.equal(plateInk(PLATE_COLOURS.white), '#1b1c1f');
  assert.equal(plateInk('nonsense'), '#1b1c1f');
});

test('the plate sits in the gap between window rows, above head height, whatever the ground level', () => {
  for (const ground of [0, 0.7, 1.6, 3.19, 35.4, 120.05]) {
    const c = plateCentre(ground, 30);
    const row = Math.floor((c - 3.25 + 1e-9) / 3.2) * 3.2; // the multiple of 3.2 the gap belongs to
    assert.ok(Math.abs(c - (row + 3.25)) < 1e-9, `${ground}: centre ${c} is mid-gap`);
    assert.ok(c - ground >= 1.9 + 0.13 && c - ground <= 1.9 + 3.2 + 3.25, `${ground}: ${c - ground} m up`);
    assert.ok(c - 0.13 * 3 >= row + 2.5 && c + 0.13 * 3 <= row + 4.0, `${ground}: even at size 3 it clears both rows`);
  }
  assert.equal(plateCentre(0, 3.5), null, 'a one-storey wall has no room');
  assert.notEqual(plateCentre(0, 6), null);
  assert.equal(plateCentre(40, 3), null, 'height is relative to the ground');
});

test('the plate pieces stack out from the wall and sit inside each other', () => {
  for (const size of [0.7, 1, 2, 3]) {
    const parts = plateParts(size);
    const border = parts.find((b) => b.role === 'border');
    const plate = parts.find((b) => b.role === 'plate');
    assert.equal(border.v0, 0, 'flush on the wall');
    assert.ok(plate.v0 >= border.v1 - 1e-12 && plate.u0 > border.u0 && plate.u1 < border.u1 && plate.h0 > border.h0 && plate.h1 < border.h1);
    for (const t of parts.filter((b) => b.role === 'text')) assert.ok(t.v0 >= plate.v1 - 1e-12 && t.u0 > plate.u0 && t.u1 < plate.u1 && t.h0 > plate.h0 && t.h1 < plate.h1);
    for (const b of parts) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
  }
});

test('size grows the plate about its centre and clamps to 0.7..3', () => {
  const w = (p) => p[0].u1 - p[0].u0;
  assert.ok(Math.abs(w(plateParts(2)) / w(plateParts(1)) - 2) < 1e-9);
  assert.deepEqual(plateParts(99), plateParts(3));
  assert.deepEqual(plateParts(0), plateParts(1));
  assert.equal(plateSize(0.1), 0.7);
  const p = plateParts(2);
  assert.ok(Math.abs(p[0].h0 + p[0].h1) < 1e-12, 'centred on h = 0');
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wPlateColour">(.*?)<\/select>/s);
  assert.ok(m, '#wPlateColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), PLATE_CHOICES);
});
