import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DRINK_COLOURS, VENDING_CHOICES, VENDING_COLOURS, vendingChance, vendingColour, vendingGroupSize, vendingParts, vendingSpacing,
} from '../web/js/vending.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };

test('machines are dense in Japan, sparser in Korea and Indonesia, rare elsewhere', () => {
  const s = [tokyo, seoul, jakarta, paris].map(vendingSpacing);
  assert.deepEqual(s, [14, 30, 45, 90]);
  assert.equal(vendingSpacing(null), 90, 'no place known');
});

test('the chance of a machine scales with density and with the sampling interval, and stays a probability', () => {
  assert.equal(vendingChance(0, 14, 10), 0);
  assert.equal(vendingChance(100, 20, 10), 0.5);
  assert.equal(vendingChance(50, 20, 10), 0.25);
  assert.equal(vendingChance(100, 5, 10), 1, 'never above 1');
  assert.equal(vendingChance(500, 20, 10), 0.5, 'density clamps at 100%');
  assert.equal(vendingChance(-5, 20, 10), 0);
  assert.equal(vendingChance('x', 20, 10), 0);
});

test('a chosen colour is used as is, and mixed or unknown choices pick from all of them by the random value', () => {
  assert.equal(vendingColour('red', 0.9), VENDING_COLOURS.red);
  const all = Object.values(VENDING_COLOURS);
  assert.equal(vendingColour('mixed', 0), all[0]);
  assert.equal(vendingColour('mixed', 0.999), all[all.length - 1]);
  assert.equal(vendingColour('toString', 0), all[0], 'an inherited property name from the URL is not a colour');
  assert.equal(vendingColour('bogus', 0.5), vendingColour('mixed', 0.5));
});

test('group sizes follow the 55 / 30 / 15 split', () => {
  assert.deepEqual([0, 0.54, 0.55, 0.84, 0.85, 0.999].map(vendingGroupSize), [1, 1, 2, 2, 3, 3]);
});

test('a machine is well-formed boxes of machine size, with cans from the drink palette', () => {
  const parts = vendingParts(() => 0.5);
  const body = parts.find((p) => p.role === 'body');
  assert.ok(body.h1 > 1.6 && body.h1 < 2, 'about 1.8 m tall');
  for (const p of parts) {
    assert.ok(p.u0 < p.u1 && p.v0 < p.v1 && p.h0 < p.h1, `${p.role} is not degenerate`);
    assert.ok(Math.abs(p.v0) <= 0.43 && Math.abs(p.v1) <= 0.43, `${p.role} stays within the width`);
  }
  const cans = parts.filter((p) => p.role === 'drink');
  assert.equal(cans.length, 15);
  assert.ok(cans.every((c) => c.slot >= 0 && c.slot < DRINK_COLOURS.length && Number.isInteger(c.slot)));
  assert.ok(cans.every((c) => c.u0 >= body.u1), 'the cans sit on the front, in the window');
  assert.notDeepEqual(vendingParts(() => 0.1).filter((p) => p.role === 'drink').map((c) => c.slot), vendingParts(() => 0.9).filter((p) => p.role === 'drink').map((c) => c.slot), 'the random stream changes the cans');
});

// The panel's colour options must be exactly the colours the code knows.
test('the colour options in the panel match the vending table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wVendingColour">(.*?)<\/select>/s);
  assert.ok(m, '#wVendingColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), VENDING_CHOICES);
});
