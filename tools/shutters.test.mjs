import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SHUTTER_CHOICES, SHUTTER_COLOURS, isClosed, shutterChance, shutterColour, shutterParts, shutterRows, shutterRun, shutterSpacing } from '../web/js/shutters.js';

const paris = { lat: 48.86, lon: 2.29 };
const rome = { lat: 41.9, lon: 12.5 };
const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const nyc = { lat: 40.7, lon: -74 };

test('spacing: France densest, then the Mediterranean, then the world, and almost none in Japan and Korea', () => {
  const [p, r, n, t, s] = [paris, rome, nyc, tokyo, seoul].map(shutterSpacing);
  assert.ok(p < r && r < n && n < t);
  assert.equal(t, s);
  assert.equal(shutterSpacing(null), n);
});

test('chance: percentage per sample, clamped, bad input is none', () => {
  assert.equal(shutterChance(100, 50, 10), 0.2);
  assert.equal(shutterChance(0, 50, 10), 0);
  assert.equal(shutterChance(100, 5, 10), 1);
  assert.equal(shutterChance('x', 50, 10), 0);
});

test('colour: a chosen one wins; auto draws from the place palette', () => {
  assert.equal(shutterColour('blue', paris, 0.5), SHUTTER_COLOURS.blue);
  const draw = (c) => new Set(Array.from({ length: 60 }, (_, i) => shutterColour('auto', c, i / 60)));
  assert.deepEqual([...draw(paris)].sort(), [SHUTTER_COLOURS.cream, SHUTTER_COLOURS.green, SHUTTER_COLOURS.grey].sort());
  assert.deepEqual([...draw(rome)].sort(), [SHUTTER_COLOURS.blue, SHUTTER_COLOURS.brown, SHUTTER_COLOURS.green].sort());
  assert.deepEqual([...draw(nyc)].sort(), [SHUTTER_COLOURS.brown, SHUTTER_COLOURS.grey, SHUTTER_COLOURS.white].sort());
  assert.equal(shutterColour('toString', paris, 0.1), shutterColour('auto', paris, 0.1));
  assert.equal(shutterColour('auto', paris, 9), shutterColour('auto', paris, 0.999));
});

test('run length: 1 to 5 windows and every length is reachable', () => {
  assert.deepEqual([...new Set(Array.from({ length: 50 }, (_, i) => shutterRun(i / 50)))].sort(), [1, 2, 3, 4, 5]);
  assert.equal(shutterRun(7), 5);
  assert.equal(shutterRun(-1), 1);
});

test('closed share is a percentage of windows', () => {
  const draws = Array.from({ length: 100 }, (_, i) => i / 100);
  assert.equal(draws.filter((u) => isClosed(0, u)).length, 0);
  assert.equal(draws.filter((u) => isClosed(100, u)).length, 100);
  assert.equal(draws.filter((u) => isClosed(15, u)).length, 15);
  assert.equal(isClosed('x', 0), false);
});

test('rows: every row whose window fits between ground and roof, whatever the ground level; share thins them', () => {
  for (const ground of [0, 1.1, 35.5, 118.2]) {
    const rows = shutterRows(ground, 20, () => 0, 1);
    assert.ok(rows.length >= 5 && rows.length <= 7, `${ground}: ${rows.length}`);
    for (const m of rows) {
      assert.ok(Math.abs(m / 3.2 - Math.round(m / 3.2)) < 1e-9, 'a multiple of 3.2');
      assert.ok(m + 0.8 >= ground + 0.3 - 1e-9 && m + 2.5 <= ground + 20 - 0.4 + 1e-9, 'window inside the wall');
    }
    for (let i = 1; i < rows.length; i++) assert.ok(Math.abs(rows[i] - rows[i - 1] - 3.2) < 1e-9);
  }
  assert.deepEqual(shutterRows(0, 20, () => 0.99, 0.8), []);
  assert.deepEqual(shutterRows(0, 3, () => 0, 1), [0], 'the ground row, as a plain 0 and not -0');
  assert.deepEqual(shutterRows(0, 2.8, () => 0, 1), [], 'a wall too low for a window row');
});

test('open shutters stand beside the window and clear their neighbour; closed ones cover its two halves', () => {
  const open = shutterParts(false).filter((b) => b.role === 'panel');
  const closed = shutterParts(true).filter((b) => b.role === 'panel');
  assert.equal(open.length, 2);
  assert.equal(closed.length, 2);
  for (const b of open) assert.ok(Math.min(Math.abs(b.u0), Math.abs(b.u1)) >= 0.8 && Math.max(Math.abs(b.u0), Math.abs(b.u1)) <= 1.5 - 0.2, 'beside the 1.6 m window, inside the half cell');
  for (const b of closed) assert.ok(Math.max(Math.abs(b.u0), Math.abs(b.u1)) <= 0.8 + 1e-9, 'within the window width');
  assert.ok(closed[0].u1 < closed[1].u0 + 1e-9 || closed[1].u1 < closed[0].u0 + 1e-9, 'the two halves do not overlap');
  assert.ok(closed[0].v0 > open[0].v0, 'closed shutters stand proud of the glass');
  for (const set of [shutterParts(false), shutterParts(true)]) {
    for (const b of set) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
    const panel = set.filter((b) => b.role === 'panel');
    for (const slat of set.filter((b) => b.role === 'slat')) {
      assert.ok(panel.some((p) => slat.u0 >= p.u0 && slat.u1 <= p.u1 && slat.h0 >= p.h0 && slat.h1 <= p.h1 && slat.v0 >= p.v1 - 1e-12), 'a slat lies on a panel face');
    }
  }
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wShutterColour">(.*?)<\/select>/s);
  assert.ok(m, '#wShutterColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), SHUTTER_CHOICES);
});
