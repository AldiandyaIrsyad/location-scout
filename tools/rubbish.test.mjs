import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BAG_COLOURS, BIN_CHOICES, BIN_COLOURS, RUBBISH_KINDS, bagColour, bagPile, binColour, binParts, rubbishChance, rubbishKind, rubbishSpacing } from '../web/js/rubbish.js';

const nyc = { lat: 40.7, lon: -74 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.2, lon: 106.8 };
const tokyo = { lat: 35.66, lon: 139.7 };
const paris = { lat: 48.86, lon: 2.29 };
const sydney = { lat: -33.9, lon: 151.2 };

const share = (choice, center, kind) => Array.from({ length: 200 }, (_, i) => rubbishKind(choice, center, i / 200)).filter((x) => x === kind).length / 200;

test('spacing: New York has the most rubbish, Japan the least', () => {
  const s = [nyc, jakarta, seoul, paris, sydney, tokyo].map(rubbishSpacing);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1] < s[i], `${i}: ${s}`);
  assert.equal(rubbishSpacing(null), rubbishSpacing(sydney));
});

test('chance: percentage per sample, clamped, bad input is none', () => {
  assert.equal(rubbishChance(100, 50, 10), 0.2);
  assert.equal(rubbishChance(0, 50, 10), 0);
  assert.equal(rubbishChance(100, 5, 10), 1);
  assert.equal(rubbishChance(900, 50, 10), 0.2);
  assert.equal(rubbishChance('x', 50, 10), 0);
});

test('kind: bins gives no bags, bags gives no bins, mixed splits, and auto follows the place', () => {
  assert.equal(share('bins', paris, 'bags'), 0);
  assert.equal(share('bags', paris, 'wheelie') + share('bags', paris, 'litter'), 0);
  assert.equal(share('mixed', paris, 'bags'), 0.5);
  assert.ok(share('auto', nyc, 'bags') > share('auto', sydney, 'bags'));
  assert.ok(share('auto', sydney, 'bags') > share('auto', paris, 'bags'));
  assert.equal(share('auto', seoul, 'bags'), share('auto', nyc, 'bags'));
  assert.equal(share('toString', paris, 'bags'), share('auto', paris, 'bags'));
  const bins = Array.from({ length: 100 }, (_, i) => rubbishKind('bins', paris, i / 100));
  assert.equal(bins.filter((x) => x === 'wheelie').length, 60);
  assert.equal(bins.filter((x) => x === 'litter').length, 40);
  assert.equal(rubbishKind('auto', paris, 7), rubbishKind('auto', paris, 0.999));
});

test('bin and bag colours', () => {
  assert.equal(binColour('blue', 0.9), BIN_COLOURS.blue);
  assert.equal(new Set(Array.from({ length: 80 }, (_, i) => binColour('mixed', i / 80))).size, Object.keys(BIN_COLOURS).length);
  assert.equal(binColour('toString', 0), binColour('mixed', 0));
  const bags = Array.from({ length: 60 }, (_, i) => bagColour(i / 60));
  assert.ok(bags.every((c) => BAG_COLOURS.includes(c)));
  assert.ok(bags.filter((c) => c === '#1d1e21').length > bags.length / 4, 'mostly black');
  assert.equal(bagColour(9), BAG_COLOURS.at(-1));
});

const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('a bag pile: count clamps to 2..8, the lower bags rest on the ground and the rest are stacked on them', () => {
  assert.equal(bagPile(1, seq([0.5])).length, 2);
  assert.equal(bagPile(99, seq([0.5])).length, 8);
  assert.equal(bagPile(NaN, seq([0.5])).length, 2);
  const bags = bagPile(8, seq([0.1, 0.9, 0.4, 0.6]));
  const base = bags.filter((b) => Math.abs(b.h - b.r * 0.85) < 1e-9);
  assert.ok(base.length >= 5 && base.length < 8, `${base.length} on the ground`);
  for (const top of bags.filter((b) => !base.includes(b))) {
    const supported = base.some((b) => Math.hypot(b.u - top.u, b.v - top.v) < b.r + top.r && top.h > b.h);
    assert.ok(supported, 'a stacked bag sits above a ground bag');
  }
  for (const b of bags) assert.ok(Math.hypot(b.u, b.v) < 0.5 && b.r > 0.15 && b.r < 0.35);
});

test('a bag pile scales with size and its bags stay the same in number', () => {
  const a = bagPile(5, seq([0.3, 0.7]), 1);
  const b = bagPile(5, seq([0.3, 0.7]), 1.5);
  assert.equal(a.length, b.length);
  assert.ok(Math.abs(b[0].r / a[0].r - 1.5) < 1e-9);
  assert.deepEqual(bagPile(5, seq([0.3, 0.7]), 9), b);
});

test('a wheelie bin has a lid above the body and wheels at the back; a litter bin is round on a foot', () => {
  const w = binParts('wheelie', 1);
  assert.equal(w.cyl, null);
  const body = w.boxes.find((b) => b.role === 'body');
  const lid = w.boxes.find((b) => b.role === 'lid');
  assert.ok(lid.h0 >= body.h1 - 1e-9 && lid.u1 > body.u1, 'the lid sits on top and overhangs');
  assert.ok(w.boxes.filter((b) => b.role === 'wheel').every((b) => b.v1 <= 0 + 1e-9), 'wheels at the back (-v)');
  assert.equal(Math.min(...w.boxes.map((b) => b.h0)), 0);
  const l = binParts('litter', 1);
  assert.ok(l.cyl.r > 0.15 && l.cyl.h1 > l.cyl.h0);
  assert.ok(l.boxes.find((b) => b.role === 'lid').h0 >= l.cyl.h1 - 1e-9);
  for (const b of [...w.boxes, ...l.boxes]) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
});

test('bin size scales and clamps to 0.7..1.5', () => {
  const top = (p) => Math.max(...p.boxes.map((b) => b.h1));
  assert.ok(Math.abs(top(binParts('wheelie', 1.5)) / top(binParts('wheelie', 1)) - 1.5) < 1e-9);
  assert.deepEqual(binParts('litter', 9), binParts('litter', 1.5));
  assert.deepEqual(binParts('wheelie', 0), binParts('wheelie', 1));
  assert.ok(Math.abs(binParts('litter', 1.5).cyl.r / binParts('litter', 1).cyl.r - 1.5) < 1e-9);
});

test('the kind and colour options in the panel match the tables', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const opts = (id) => {
    const m = html.match(new RegExp(`id="${id}">(.*?)</select>`, 's'));
    assert.ok(m, `#${id} exists`);
    return [...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(opts('wRubbishKind'), RUBBISH_KINDS);
  assert.deepEqual(opts('wBinColour'), BIN_CHOICES);
});
