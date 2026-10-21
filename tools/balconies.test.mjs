import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BALCONY_STYLES, LAUNDRY_COLOURS, balconyChance, balconyParts, balconySpacing, balconyStyleFor, columnCentre, laundryItems, slabHeights } from '../web/js/balconies.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };
const nyc = { lat: 40.7, lon: -74 };
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

test('auto style by place: solid parapets in Japan and Korea, railings elsewhere; a chosen style wins', () => {
  assert.deepEqual([tokyo, seoul, paris, null].map((c) => balconyStyleFor('auto', c)), ['solid', 'solid', 'rail', 'rail']);
  assert.equal(balconyStyleFor('rail', tokyo), 'rail');
  assert.equal(balconyStyleFor('solid', paris), 'solid');
  assert.equal(balconyStyleFor('toString', tokyo), 'solid');
});

test('spacing by place: Tokyo most, then Korea, Europe, Indonesia, the rest', () => {
  assert.deepEqual([tokyo, seoul, paris, jakarta, nyc, null].map(balconySpacing), [11, 16, 20, 30, 34, 34]);
});

test('chance scales with density and clamps', () => {
  assert.equal(balconyChance(100, 20, 10), 0.5);
  assert.equal(balconyChance(0, 20, 10), 0);
  assert.equal(balconyChance(100, 5, 10), 1);
  assert.equal(balconyChance(500, 20, 10), 0.5);
  assert.equal(balconyChance('x', 20, 10), 0);
});

test('the column centre is the middle of the 3 m window column, on both sides of zero', () => {
  assert.equal(columnCentre(0), 1.5);
  assert.equal(columnCentre(2.9), 1.5);
  assert.equal(columnCentre(3), 4.5);
  assert.equal(columnCentre(-0.1), -1.5);
  assert.equal(columnCentre(-3.1), -4.5);
});

test('slab heights sit on the window sill of a row, skip the ground floor, and stop below the roof', () => {
  const all = slabHeights(0, 20, () => 0, 1);
  const want = [4, 7.2, 10.4, 13.6, 16.8];
  assert.equal(all.length, want.length);
  all.forEach((h, i) => assert.ok(Math.abs(h - want[i]) < 1e-9));
  assert.ok(all.every((h) => Math.abs(((h - 0.8) / 3.2) - Math.round((h - 0.8) / 3.2)) < 1e-9), 'sills at 0.8 above a multiple of 3.2');
  assert.ok(all.every((h) => h >= 2.4 && h + 2.2 <= 20), 'above the ground floor, under the roof');
  assert.deepEqual(slabHeights(0, 5, () => 0, 1), [], 'a low building has no balconies');
  assert.deepEqual(slabHeights(0, 20, () => 0.99, 0.5), [], 'the share decides each row');
  const hilltop = slabHeights(100, 12, () => 0, 1);
  assert.ok(hilltop.every((h) => h >= 102.4 && h + 2.2 <= 112), 'measured from the wall ground');
  assert.ok(hilltop.every((h) => Math.abs(((h - 0.8) / 3.2) - Math.round((h - 0.8) / 3.2)) < 1e-9), 'still on the world window grid');
});

test('a solid balcony has a parapet round three sides, a railing one has bars and posts; both have a slab', () => {
  const solid = balconyParts('solid', 2);
  assert.equal(solid.filter((b) => b.role === 'slab').length, 1);
  assert.equal(solid.filter((b) => b.role === 'solid').length, 3);
  assert.ok(solid.every((b) => b.role !== 'rail'));
  const rail = balconyParts('rail', 2);
  assert.ok(rail.filter((b) => b.role === 'rail').length > 8);
  assert.ok(rail.every((b) => b.role !== 'solid'));
  for (const b of [...solid, ...rail]) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
  assert.ok(Math.max(...solid.map((b) => b.h1)) > 1 && Math.max(...rail.map((b) => b.h1)) > 1, 'about a metre high');
  const wide = balconyParts('rail', 3);
  assert.ok(wide.filter((b) => b.role === 'rail').length > rail.filter((b) => b.role === 'rail').length, 'wider means more posts');
  assert.ok(Math.max(...wide.map((b) => b.u1)) === 1.5);
});

test('laundry: none at 0%, a pole with hanging items otherwise, never more than six items, kept inside the balcony', () => {
  assert.deepEqual(laundryItems(0, 2, () => 0), []);
  assert.deepEqual(laundryItems('x', 2, () => 0), []);
  assert.deepEqual(laundryItems(50, 2, () => 0.999), [], 'sometimes the balcony is empty (rand above the share)');
  const full = laundryItems(100, 2, seq(0, 0.9, 0.5, 0.2, 0.7, 0.1, 0.4));
  assert.equal(full[0].role, 'pole');
  const items = full.filter((x) => x.role === 'item');
  assert.ok(items.length >= 1 && items.length <= 6);
  for (const it of items) {
    assert.ok(it.u0 >= -1 && it.u1 <= 1, 'inside the balcony');
    assert.ok(it.h1 === 2 && it.h0 > 1.0 && it.h0 < 1.5, 'hangs from the pole at 2 m');
    assert.ok(LAUNDRY_COLOURS.includes(it.colour));
  }
  const sorted = [...items].sort((a, b) => a.u0 - b.u0);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].u0 >= sorted[i - 1].u1 - 1e-9, 'items do not overlap');
  assert.ok(laundryItems(100, 2, () => 0).length > laundryItems(20, 2, () => 0).length, 'more laundry at a higher amount');
  assert.ok(laundryItems(100, 2, () => 0).some((x) => x.role === 'futon'), 'a futon over the rail with the right roll');
  assert.ok(!laundryItems(100, 2, () => 0.9).some((x) => x.role === 'futon'));
});

test('the style options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wBalconyStyle">(.*?)<\/select>/s);
  assert.ok(m, '#wBalconyStyle exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), BALCONY_STYLES);
});
