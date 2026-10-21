import assert from 'node:assert/strict';
import test from 'node:test';
import { POLE_LOOK, catenary, hasTransformer, poleStyleFor, spanSag, wireSlots, wireSpans } from '../web/js/wires.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };

test('auto pole style is concrete in Japan, Korea and Indonesia and wood elsewhere', () => {
  for (const c of [tokyo, seoul, jakarta]) assert.equal(poleStyleFor('auto', c), 'concrete');
  assert.equal(poleStyleFor('auto', paris), 'wood');
  assert.equal(poleStyleFor('auto', null), 'wood', 'no place known');
});

test('a chosen pole style wins over the place, and unknown choices fall back to auto', () => {
  assert.equal(poleStyleFor('steel', tokyo), 'steel');
  assert.equal(poleStyleFor('wood', tokyo), 'wood');
  assert.equal(poleStyleFor('toString', tokyo), 'concrete', 'an inherited property name from the URL is not a style');
  assert.equal(poleStyleFor('bogus', paris), 'wood');
  assert.ok(Object.keys(POLE_LOOK).every((k) => POLE_LOOK[k].width > 0));
});

test('wire slots: power wires fill the cross-arm first, then the telephone lines go lower', () => {
  assert.equal(wireSlots(0).length, 0);
  assert.equal(wireSlots(3).every((s) => s.down === 0.35), true);
  const six = wireSlots(6);
  assert.equal(six.length, 6);
  assert.ok(six.slice(3).every((s) => s.down > 1), 'the extra wires hang below the arm');
  assert.equal(wireSlots(9).length, 6, 'capped');
  assert.equal(wireSlots(-2).length, 0);
  assert.equal(wireSlots('x').length, 0, 'not a number');
  assert.equal(wireSlots(2.9).length, 2, 'fractions round down');
});

test('a wire sags on a parabola: ends stay put, the middle drops by the sag, even when the poles differ in height', () => {
  const pts = catenary([0, 8, 0], [30, 8, 0], 0.6, 6);
  assert.equal(pts.length, 7);
  assert.deepEqual(pts[0], [0, 8, 0]);
  assert.deepEqual(pts[6], [30, 8, 0]);
  assert.ok(Math.abs(pts[3][1] - 7.4) < 1e-9, 'the middle drops by the full sag');
  assert.ok(pts[1][1] > pts[2][1] && pts[2][1] > pts[3][1], 'monotone to the middle');
  const slope = catenary([0, 8, 0], [10, 6, 0], 0, 2);
  assert.equal(slope[1][1], 7, 'no sag on a sloped span is a straight line');
  assert.equal(catenary([0, 0, 0], [1, 0, 0], 1, 0).length, 3, 'at least two pieces');
});

test('wire spans join neighbours but not across a gap where a pole was blocked', () => {
  const at = (...xs) => xs.map((x) => ({ x, y: 0 }));
  assert.deepEqual(wireSpans(at(0, 30, 60), 48), [[0, 1], [1, 2]]);
  assert.deepEqual(wireSpans(at(0, 30, 120, 150), 48), [[0, 1], [2, 3]], 'the 90 m hole breaks the line');
  assert.deepEqual(wireSpans(at(0), 48), []);
  assert.deepEqual(wireSpans([], 48), []);
  assert.deepEqual(wireSpans(at(0, 48), 48), [[0, 1]], 'a span exactly at the limit still connects');
});

test('transformer share is a percentage of poles, clamped', () => {
  assert.equal(hasTransformer(0, 0), false, '0% never');
  assert.equal(hasTransformer(100, 0.999), true, '100% always');
  assert.equal(hasTransformer(20, 0.19), true);
  assert.equal(hasTransformer(20, 0.2), false);
  assert.equal(hasTransformer(250, 0.99), true, 'above 100 clamps');
  assert.equal(hasTransformer(-5, 0), false, 'below 0 clamps');
  assert.equal(hasTransformer('x', 0), false, 'not a number counts as none');
});

test('sag scales with the square of the span so long spans droop more', () => {
  assert.equal(spanSag(0.5, 30), 0.5, 'the setting is the sag of a 30 m span');
  assert.equal(spanSag(0.5, 60), 2);
  assert.equal(spanSag(0.5, 15), 0.125);
  assert.equal(spanSag(-1, 30), 0);
  assert.equal(spanSag(undefined, 30), 0);
});
