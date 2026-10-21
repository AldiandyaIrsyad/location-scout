import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { LAMP_STYLES, lampChance, lampHeight, lampParts, lampSpacing, lampStyleFor } from '../web/js/lamps.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const paris = { lat: 48.86, lon: 2.29 };
const nyc = { lat: 40.7, lon: -74 };

test('auto style by place: classic in Europe, cobra heads in Japan and Korea, modern elsewhere', () => {
  assert.deepEqual([paris, tokyo, seoul, nyc, null].map((c) => lampStyleFor('auto', c)), ['classic', 'cobra', 'cobra', 'modern', 'modern']);
  assert.equal(lampStyleFor('modern', paris), 'modern', 'a chosen style wins');
  assert.equal(lampStyleFor('toString', paris), 'classic', 'an inherited name is not a style');
  assert.equal(lampStyleFor('bogus', tokyo), 'cobra');
});

test('classic lamps stand closest, modern furthest apart', () => {
  assert.ok(lampSpacing('classic') < lampSpacing('cobra') && lampSpacing('cobra') < lampSpacing('modern'));
});

test('chance scales with density and clamps', () => {
  assert.equal(lampChance(100, 20, 10), 0.5);
  assert.equal(lampChance(0, 20, 10), 0);
  assert.equal(lampChance(100, 5, 10), 1);
  assert.equal(lampChance(400, 20, 10), 0.5);
  assert.equal(lampChance('x', 20, 10), 0);
});

test('height clamps to 4..12 m, defaults to 7 on junk, and classic lamps never exceed 4.6 m', () => {
  assert.equal(lampHeight('cobra', 9), 9);
  assert.equal(lampHeight('cobra', 2), 4);
  assert.equal(lampHeight('cobra', 99), 12);
  assert.equal(lampHeight('modern', 'x'), 7);
  assert.equal(lampHeight('classic', 9), 4.6);
  assert.equal(lampHeight('classic', 4), 4);
});

test('every style stands on the ground and its bulb hangs where the lamp head is', () => {
  for (const style of ['cobra', 'classic', 'modern']) {
    const top = style === 'classic' ? 4.6 : 7;
    const p = lampParts(style, top);
    const lows = [...p.tubes.flatMap((t) => [t.a[1], t.b[1]]), ...p.boxes.map((b) => b.h0)];
    assert.equal(Math.min(...lows), 0, `${style} touches the ground`);
    const highs = [...p.tubes.flatMap((t) => [t.a[1], t.b[1]]), ...p.boxes.map((b) => b.h1)];
    assert.ok(Math.max(...highs) >= top - 0.9 && Math.max(...highs) <= top + 1.2, `${style} tops out near its height`);
    const glass = p.boxes.filter((b) => b.role === 'glass');
    assert.ok(glass.length === 1, `${style} has one lamp glass`);
    const g = glass[0];
    assert.ok(p.bulb[0] >= g.u0 && p.bulb[0] <= g.u1 && p.bulb[1] >= g.h0 && p.bulb[1] <= g.h1 + 0.05, `${style}: bulb inside the glass`);
    for (const b of p.boxes) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
    for (const t of p.tubes) assert.ok(t.r > 0);
  }
});

test('cobra and modern lamps reach over the road (u > 0) while a classic post stands upright', () => {
  const reach = (s) => Math.max(...lampParts(s, 6).boxes.map((b) => b.u1));
  assert.ok(reach('cobra') > 1.5 && reach('modern') > 2);
  assert.ok(reach('classic') < 0.3);
});

test('the style options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wLampStyle">(.*?)<\/select>/s);
  assert.ok(m, '#wLampStyle exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), LAMP_STYLES);
});
