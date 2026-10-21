import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BIKE_COLOURS, WHEEL_RADIUS, bicycleParts, bikeChance, bikeColour, bikeGroup, bikeSpacing, bikeStyle } from '../web/js/bicycle.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };

test('spacing by place: Tokyo has the most bikes, and Korea is not mistaken for Japan', () => {
  assert.deepEqual([tokyo, paris, seoul, jakarta, null].map(bikeSpacing), [16, 26, 45, 70, 50]);
});

test('chance scales with density and clamps', () => {
  assert.equal(bikeChance(100, 20, 10), 0.5);
  assert.equal(bikeChance(0, 20, 10), 0);
  assert.equal(bikeChance(100, 5, 10), 1);
  assert.equal(bikeChance(900, 20, 10), 0.5);
  assert.equal(bikeChance('x', 20, 10), 0);
});

test('colour choice wins; mixed and unknown cover the palette by u', () => {
  assert.equal(bikeColour('pink', 0), BIKE_COLOURS.pink);
  assert.equal(bikeColour('toString', 0), BIKE_COLOURS.black, 'an inherited name is not a colour');
  assert.equal(new Set([0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.99].map((u) => bikeColour('mixed', u))).size, 7);
  assert.equal(bikeColour('mixed', 1), bikeColour('mixed', 0.99));
});

test('groups: alone, a short row, or a rack, with counts that stay in range at the edges of u', () => {
  assert.deepEqual(bikeGroup(0), { count: 1, row: false });
  assert.deepEqual(bikeGroup(0.49), { count: 1, row: false });
  assert.deepEqual(bikeGroup(0.5), { count: 2, row: true });
  assert.deepEqual(bikeGroup(0.79), { count: 3, row: true });
  assert.deepEqual(bikeGroup(0.8), { count: 4, row: true });
  assert.deepEqual(bikeGroup(0.999), { count: 5, row: true });
});

test('style: a chosen style wins, mixed and unknown choices are mostly city bikes', () => {
  assert.equal(bikeStyle('road', 0), 'road');
  assert.equal(bikeStyle('city', 0.99), 'city');
  assert.equal(bikeStyle('mixed', 0.69), 'city');
  assert.equal(bikeStyle('mixed', 0.7), 'road');
  assert.equal(bikeStyle('toString', 0.1), 'city');
});

test('a bicycle sits on the ground: two wheels a bike-length apart, every part above ground and the frame joined up', () => {
  for (const style of ['city', 'road']) {
    const b = bicycleParts(style);
    assert.equal(b.wheels.length, 2);
    assert.ok(b.wheels[1].u - b.wheels[0].u > 0.9 && b.wheels[1].u - b.wheels[0].u < 1.2, 'wheelbase of about a metre');
    assert.ok(b.wheels.every((w) => w.r === WHEEL_RADIUS && w.h === WHEEL_RADIUS), 'axles one radius up');
    for (const t of b.tubes) for (const p of [t.a, t.b]) assert.ok(p[1] >= 0.2 && p[1] <= 1.1, `tube end height ${p[1]}`);
    const uses = new Map();
    for (const t of b.tubes) for (const p of [t.a.join(), t.b.join()]) uses.set(p, (uses.get(p) || 0) + 1);
    for (const t of b.tubes.filter((x) => x.role === 'frame')) {
      assert.ok(uses.get(t.a.join()) > 1 || uses.get(t.b.join()) > 1, 'a loose frame tube');
    }
    assert.ok(b.boxes.every((x) => x.u0 < x.u1 && x.v0 < x.v1 && x.h0 < x.h1));
  }
});

test('a city bike has a basket and a rear rack that a road bike lacks, and the road bike has lower handlebars', () => {
  const city = bicycleParts('city');
  const road = bicycleParts('road');
  assert.ok(city.boxes.some((x) => x.role === 'basket'));
  assert.ok(!road.boxes.some((x) => x.role === 'basket'));
  assert.ok(city.boxes.length > road.boxes.length);
  const barH = (b) => Math.max(...b.tubes.filter((t) => t.a[2] === -0.28).map((t) => t.a[1]));
  assert.ok(barH(road) < barH(city));
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wBikeColour">(.*?)<\/select>/s);
  assert.ok(m, '#wBikeColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['mixed', ...Object.keys(BIKE_COLOURS)]);
  const s = html.match(/id="wBikeStyle">(.*?)<\/select>/s);
  assert.ok(s, '#wBikeStyle exists');
  assert.deepEqual([...s[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['mixed', 'city', 'road']);
});
