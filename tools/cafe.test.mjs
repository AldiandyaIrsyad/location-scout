import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CHAIR_CHOICES, CHAIR_COLOURS, PARASOL_COLOURS, cafeChance, cafeSpacing, chairColour, chairParts, hasParasol, parasolColour, parasolParts, tableParts, terraceLayout } from '../web/js/cafe.js';

const paris = { lat: 48.86, lon: 2.29 };
const tokyo = { lat: 35.66, lon: 139.7 };
const bangkok = { lat: 13.75, lon: 100.5 };
const nyc = { lat: 40.7, lon: -74 };

// a small seeded generator; the first draws of neighbouring seeds are close, so skip a few
const lcg = (seed) => {
  let s = seed;
  const next = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < 6; i++) next();
  return next;
};

test('spacing: Europe most, then South-East Asia, then Japan/Korea, then the rest', () => {
  const [p, b, t, n] = [paris, bangkok, tokyo, nyc].map(cafeSpacing);
  assert.ok(p < b && b < t && t < n);
  assert.equal(cafeSpacing(null), n);
});

test('chance: percentage per sample, clamped, bad input is none', () => {
  assert.equal(cafeChance(100, 50, 10), 0.2);
  assert.equal(cafeChance(0, 50, 10), 0);
  assert.equal(cafeChance(100, 5, 10), 1);
  assert.equal(cafeChance('x', 50, 10), 0);
});

test('chair colour: a chosen one wins; auto draws from the place palette', () => {
  assert.equal(chairColour('red', paris, 0.5), CHAIR_COLOURS.red);
  const draw = (c) => new Set(Array.from({ length: 60 }, (_, i) => chairColour('auto', c, i / 60)));
  assert.deepEqual([...draw(paris)].sort(), [CHAIR_COLOURS.black, CHAIR_COLOURS.rattan].sort());
  assert.deepEqual([...draw(tokyo)].sort(), [CHAIR_COLOURS.black, CHAIR_COLOURS.green, CHAIR_COLOURS.white].sort());
  assert.deepEqual([...draw(nyc)].sort(), [CHAIR_COLOURS.black, CHAIR_COLOURS.red].sort());
  assert.equal(chairColour('toString', paris, 0), chairColour('auto', paris, 0));
  assert.equal(chairColour('auto', paris, 9), chairColour('auto', paris, 0.999));
});

test('parasol share is a percentage of tables and the canopy colours are all reachable', () => {
  const draws = Array.from({ length: 100 }, (_, i) => i / 100);
  assert.equal(draws.filter((u) => hasParasol(0, u)).length, 0);
  assert.equal(draws.filter((u) => hasParasol(100, u)).length, 100);
  assert.equal(draws.filter((u) => hasParasol(30, u)).length, 30);
  assert.equal(new Set(draws.map(parasolColour)).size, PARASOL_COLOURS.length);
  assert.equal(parasolColour(9), PARASOL_COLOURS.at(-1));
});

test('a terrace has one to four tables in a row along the wall, each with two or three chairs facing it', () => {
  const counts = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const { tables } = terraceLayout(lcg(seed), 1);
    counts.add(tables.length);
    assert.ok(tables.length >= 1 && tables.length <= 4);
    assert.ok(Math.abs(tables.reduce((s, t) => s + t.u, 0)) < 1e-9, 'centred on the terrace origin');
    for (let i = 1; i < tables.length; i++) assert.ok(Math.abs(tables[i].u - tables[i - 1].u - 1.7) < 1e-9, 'tables 1.7 m apart');
    for (const t of tables) {
      assert.ok(t.chairs.length === 2 || t.chairs.length === 3);
      for (const c of t.chairs) {
        assert.ok(Math.abs(Math.hypot(c.u - t.u, c.v - t.v) - 0.58) < 1e-9, 'a chair stands 0.58 m from its table');
        const toward = Math.atan2(t.v - c.v, t.u - c.u);
        const diff = Math.abs(Math.atan2(Math.sin(c.face - toward), Math.cos(c.face - toward)));
        assert.ok(diff < 1e-9, 'faces the table');
      }
    }
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3, 4]);
});

test('chairs of one table do not sit on top of each other', () => {
  for (let seed = 1; seed <= 100; seed++) {
    for (const t of terraceLayout(lcg(seed)).tables) {
      for (let i = 0; i < t.chairs.length; i++) for (let j = i + 1; j < t.chairs.length; j++) {
        assert.ok(Math.hypot(t.chairs[i].u - t.chairs[j].u, t.chairs[i].v - t.chairs[j].v) > 0.42, `seed ${seed}`);
      }
    }
  }
});

test('size spreads the terrace and clamps to 0.7..1.5', () => {
  const a = terraceLayout(lcg(7), 1);
  const b = terraceLayout(lcg(7), 1.5);
  assert.equal(a.tables.length, b.tables.length);
  if (a.tables.length > 1) assert.ok(Math.abs((b.tables[1].u - b.tables[0].u) / (a.tables[1].u - a.tables[0].u) - 1.5) < 1e-9);
  assert.deepEqual(terraceLayout(lcg(7), 9), b);
});

test('table, chair and parasol dimensions are plausible and stand on the ground', () => {
  const table = tableParts(1);
  assert.equal(Math.min(...table.map((b) => b.h0)), 0);
  const top = table.find((b) => b.role === 'top');
  assert.ok(top.h1 > 0.7 && top.h1 < 0.8);
  const chair = chairParts(1);
  assert.equal(Math.min(...chair.map((b) => b.h0)), 0);
  assert.equal(chair.filter((b) => b.role === 'leg').length, 4);
  const seat = chair.find((b) => b.role === 'seat');
  const back = chair.find((b) => b.role === 'back');
  assert.ok(seat.h1 > 0.4 && seat.h1 < 0.5);
  assert.ok(back.v1 <= seat.v0 + 0.05 && back.h0 >= seat.h1 - 1e-9 && back.h1 > 0.8, 'the back rises behind the seat');
  for (const b of [...table, ...chair]) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
  const p = parasolParts(1);
  assert.ok(p.canopy.h0 > 1.9 && p.canopy.h1 > p.canopy.h0 && p.pole.h1 >= p.canopy.h1 - 0.1);
  assert.ok(Math.abs(parasolParts(1.5).canopy.r / p.canopy.r - 1.5) < 1e-9);
  assert.deepEqual(parasolParts(9), parasolParts(1.5));
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wCafeColour">(.*?)<\/select>/s);
  assert.ok(m, '#wCafeColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), CHAIR_CHOICES);
});
