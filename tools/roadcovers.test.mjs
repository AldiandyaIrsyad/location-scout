import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { COVER_SPACING, COVER_TONES, coverChance, coverShapes, coverTone, manholeOffset } from '../web/js/roadcovers.js';

test('chance scales with density and clamps', () => {
  assert.equal(coverChance(100, 40, 10), 0.25);
  assert.equal(coverChance(50, 40, 10), 0.125);
  assert.equal(coverChance(0, 40, 10), 0);
  assert.equal(coverChance(100, 5, 10), 1);
  assert.equal(coverChance(800, 40, 10), 0.25);
  assert.equal(coverChance('x', 40, 10), 0);
  assert.ok(COVER_SPACING.manhole > COVER_SPACING.drain, 'drains are more frequent than manholes');
});

test('tone: a chosen one wins, mixed and unknown choices cover all four by u', () => {
  assert.equal(coverTone('rust', 0), COVER_TONES.rust);
  assert.equal(coverTone('toString', 0), COVER_TONES.dark, 'an inherited name is not a tone');
  assert.equal(new Set([0, 0.3, 0.6, 0.99].map((u) => coverTone('mixed', u))).size, 4);
  assert.equal(coverTone('mixed', 1), coverTone('mixed', 0.99));
});

test('manhole offset spans the lane area and stays clear of both kerbs', () => {
  assert.equal(manholeOffset(0.5, 8), 0);
  assert.equal(manholeOffset(0, 8), -2.6);
  assert.equal(manholeOffset(1, 8), 2.6);
  assert.equal(manholeOffset(2, 8), 2.6, 'u clamps');
  assert.equal(manholeOffset(0.3, 2.5), 0, 'too narrow for the margin: the centre line');
  assert.equal(manholeOffset(0.3, 2.8), 0, 'exactly no room');
  assert.ok(Math.abs(manholeOffset(0.9, 6, 1)) < 2.5);
});

const area = (pts) => Math.abs(pts.reduce((t, p, i) => { const q = pts[(i + 1) % pts.length]; return t + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

test('shapes are real polygons of a sensible size, and size scales them (clamped to 0.5..2)', () => {
  for (const kind of ['manhole', 'drain', 'plate']) {
    const shapes = coverShapes(kind);
    assert.ok(shapes.length >= 2);
    assert.ok(area(shapes[0].pts) > 0.2 && area(shapes[0].pts) < 1, `${kind} base is a fraction of a square metre`);
    for (const s of shapes) assert.ok(s.pts.length >= 4 && area(s.pts) > 1e-4 && s.shade > 0);
    const big = coverShapes(kind, 2);
    assert.ok(Math.abs(area(big[0].pts) / area(shapes[0].pts) - 4) < 1e-9, 'twice the size is four times the area');
    assert.ok(Math.abs(area(coverShapes(kind, 9)[0].pts) - area(big[0].pts)) < 1e-9, 'size clamps at 2');
    assert.ok(Math.abs(area(coverShapes(kind, 0)[0].pts) / area(shapes[0].pts) - 1) < 1e-9, 'zero or junk counts as 1');
  }
});

test('a manhole is round (a 16-sided lid) and a drain has five dark slots', () => {
  assert.equal(coverShapes('manhole')[0].pts.length, 16);
  const m = coverShapes('manhole')[0].pts.map(([x, y]) => Math.hypot(x, y));
  assert.ok(Math.max(...m) - Math.min(...m) < 1e-9);
  const d = coverShapes('drain');
  assert.equal(d.filter((s) => s.shade < 0.6).length, 5);
  assert.ok(d.slice(1).every((s) => s.pts.every(([x, y]) => Math.abs(x) < 0.25 && Math.abs(y) < 0.45)), 'slots lie inside the grating');
});

test('the tone options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wCoverTone">(.*?)<\/select>/s);
  assert.ok(m, '#wCoverTone exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['mixed', ...Object.keys(COVER_TONES)]);
});
