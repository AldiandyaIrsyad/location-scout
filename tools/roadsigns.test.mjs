import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SIGN_KINDS, hasCurveMirror, roadSignChance, roadSignKind, roadSignSpacing, roadSignStyle, signShapes } from '../web/js/roadsigns.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const paris = { lat: 48.86, lon: 2.29 };

test('auto style follows the place, a chosen one wins, junk falls back to the place', () => {
  assert.equal(roadSignStyle('auto', tokyo), 'japan');
  assert.equal(roadSignStyle('auto', seoul), 'japan');
  assert.equal(roadSignStyle('auto', paris), 'europe');
  assert.equal(roadSignStyle('auto', null), 'europe');
  assert.equal(roadSignStyle('europe', tokyo), 'europe');
  assert.equal(roadSignStyle('japan', paris), 'japan');
  assert.equal(roadSignStyle('toString', tokyo), 'japan');
  assert.ok(roadSignSpacing(tokyo) < roadSignSpacing(paris));
});

test('chance scales with density and clamps', () => {
  assert.equal(roadSignChance(100, 50, 10), 0.2);
  assert.equal(roadSignChance(0, 50, 10), 0);
  assert.equal(roadSignChance(100, 5, 10), 1);
  assert.equal(roadSignChance(900, 50, 10), 0.2);
  assert.equal(roadSignChance('x', 50, 10), 0);
});

test('the kind mix: speed limits are the commonest, and u at both ends stays in range', () => {
  for (const style of ['japan', 'europe']) {
    const counts = {};
    for (let i = 0; i < 100; i++) { const k = roadSignKind(style, i / 100); counts[k] = (counts[k] || 0) + 1; }
    assert.ok(Object.keys(counts).every((k) => SIGN_KINDS.includes(k)));
    assert.ok(counts.limit > counts.stop, `${style}: more limits than stops`);
    assert.ok(roadSignKind(style, 1) && roadSignKind(style, -1) && roadSignKind(style, 0.9999));
  }
  assert.equal(roadSignKind('bogus', 0), 'limit');
  assert.ok(Object.keys(Object.fromEntries([0, 0.2, 0.4, 0.6, 0.8, 0.99].map((u) => [roadSignKind('japan', u), 1]))).includes('oneway'));
  assert.ok(![0, 0.2, 0.4, 0.6, 0.8, 0.99].some((u) => roadSignKind('europe', u) === 'oneway'), 'only Japan has the one-way arrow here');
});

test('curve mirrors only in Japan and Korea, by percentage', () => {
  assert.equal(hasCurveMirror(100, tokyo, 0.5), true);
  assert.equal(hasCurveMirror(100, seoul, 0.5), true);
  assert.equal(hasCurveMirror(100, paris, 0), false);
  assert.equal(hasCurveMirror(0, tokyo, 0), false);
  assert.equal(hasCurveMirror(30, tokyo, 0.29), true);
  assert.equal(hasCurveMirror(30, tokyo, 0.3), false);
  assert.equal(hasCurveMirror(500, tokyo, 0.99), true, 'clamps at 100');
  assert.equal(hasCurveMirror('x', tokyo, 0), false);
  assert.equal(hasCurveMirror(100, null, 0), false);
});

test('every sign shape is a set of real polygons inside the unit square, painted from the outside in', () => {
  for (const style of ['japan', 'europe']) for (const kind of SIGN_KINDS) {
    const shapes = signShapes(kind, style);
    assert.ok(shapes.length >= 2, `${style} ${kind} has a rim and a face`);
    for (const s of shapes) {
      assert.ok(s.pts.length >= 3 && /^#[0-9a-f]{6}$/.test(s.col));
      for (const [x, y] of s.pts) assert.ok(Math.abs(x) <= 1.2 && Math.abs(y) <= 1.2, `${kind} point (${x}, ${y})`);
      let a = 0;
      for (let i = 0, k = s.pts.length - 1; i < s.pts.length; k = i++) a += s.pts[k][0] * s.pts[i][1] - s.pts[i][0] * s.pts[k][1];
      assert.ok(Math.abs(a) > 1e-3, 'not degenerate');
    }
    const area = (s) => Math.abs(s.pts.reduce((t, p, i) => { const q = s.pts[(i + 1) % s.pts.length]; return t + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    assert.ok(area(shapes[0]) > area(shapes[1]), `${kind}: the rim is larger than the face`);
  }
});

test('stop signs differ by style: an inverted triangle in Japan, an octagon elsewhere', () => {
  assert.equal(signShapes('stop', 'japan')[0].pts.length, 3);
  assert.equal(signShapes('stop', 'europe')[0].pts.length, 8);
  assert.equal(signShapes('warning')[0].pts.length, 3);
  assert.ok(signShapes('stop', 'japan')[0].pts.every(([, y]) => y <= 0.53 && y >= -1.06), 'point down');
  const ys = signShapes('stop', 'japan')[0].pts.map(([, y]) => y);
  assert.equal(ys.filter((y) => y < -1).length, 1, 'one vertex at the bottom');
});

test('the style options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wSignStyle">(.*?)<\/select>/s);
  assert.ok(m, '#wSignStyle exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['auto', 'japan', 'europe']);
});
