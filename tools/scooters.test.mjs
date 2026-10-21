import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SCOOTER_CHOICES, SCOOTER_COLOURS, SCOOTER_STYLES, scooterChance, scooterColour, scooterGroup, scooterParts, scooterSpacing, scooterStyle } from '../web/js/scooters.js';

const jakarta = { lat: -6.2, lon: 106.8 };
const taipei = { lat: 25.03, lon: 121.56 };
const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const rome = { lat: 41.9, lon: 12.5 };
const nyc = { lat: 40.7, lon: -74 };

test('spacing by place: tightest in Southeast Asia and Taiwan, looser in Japan and Korea, loosest elsewhere', () => {
  const s = [jakarta, taipei, tokyo, seoul, rome, nyc, null].map(scooterSpacing);
  assert.ok(s[0] < s[2] && s[1] < s[2], 'Southeast Asia and Taiwan beat Japan');
  assert.ok(s[2] < s[3], 'Korea lies inside the wider Japan box but is looser');
  assert.ok(s[4] < s[5], 'Rome has more than New York');
  assert.equal(s[5], s[6]);
});

test('chance: percentage of a spot per sample, clamped, and bad input is none', () => {
  assert.equal(scooterChance(100, 50, 10), 0.2);
  assert.equal(scooterChance(50, 50, 10), 0.1);
  assert.equal(scooterChance(0, 50, 10), 0);
  assert.equal(scooterChance(100, 5, 10), 1);
  assert.equal(scooterChance(900, 50, 10), 0.2);
  assert.equal(scooterChance('x', 50, 10), 0);
});

test('colour: a named one is fixed, mixed spreads over every colour, unknown choices count as mixed', () => {
  assert.equal(scooterColour('red', 0.9), SCOOTER_COLOURS.red);
  const seen = new Set(Array.from({ length: 70 }, (_, i) => scooterColour('mixed', i / 70)));
  assert.equal(seen.size, Object.keys(SCOOTER_COLOURS).length);
  assert.equal(scooterColour('toString', 0), scooterColour('mixed', 0));
  assert.equal(scooterColour('mixed', 5), scooterColour('mixed', 0.999));
});

test('groups: lone, row and crowd bands, and the crowd is bigger than any row', () => {
  assert.deepEqual(scooterGroup(0.1), { count: 1, row: false });
  const rows = Array.from({ length: 35 }, (_, i) => scooterGroup(0.45 + (i / 35) * 0.35));
  assert.ok(rows.every((g) => g.row && g.count >= 2 && g.count <= 4));
  assert.deepEqual(new Set(rows.map((g) => g.count)), new Set([2, 3, 4]));
  const crowds = Array.from({ length: 20 }, (_, i) => scooterGroup(0.8 + (i / 20) * 0.2));
  assert.ok(crowds.every((g) => g.row && g.count >= 5 && g.count <= 8));
  assert.equal(scooterGroup(0.9999).count, 8);
});

test('style: a chosen one wins, mixed is mostly scooters, unknown counts as mixed', () => {
  assert.equal(scooterStyle('motorbike', 0), 'motorbike');
  assert.equal(scooterStyle('scooter', 0.99), 'scooter');
  assert.equal(scooterStyle('mixed', 0.5), 'scooter');
  assert.equal(scooterStyle('mixed', 0.9), 'motorbike');
  assert.equal(scooterStyle('toString', 0.9), 'motorbike');
});

test('each design: wheels on the ground, front forward, headlamp ahead of the seat, about two metres long', () => {
  for (const style of ['scooter', 'motorbike']) {
    const p = scooterParts(style, 1);
    assert.equal(p.wheels.length, 2);
    for (const w of p.wheels) assert.ok(Math.abs(w.h - w.r) < 1e-9, `${style}: wheel touches the ground`);
    const [rear, front] = [...p.wheels].sort((a, b) => a.u - b.u);
    assert.ok(front.u > 0 && rear.u < 0);
    const lamp = p.boxes.find((b) => b.role === 'light');
    const seat = p.boxes.find((b) => b.role === 'seat');
    assert.ok(lamp.u0 > seat.u1, `${style}: headlamp ahead of the seat`);
    const tail = p.boxes.find((b) => b.role === 'tail');
    assert.ok(tail.u1 < seat.u1, `${style}: tail light behind the seat front`);
    const lo = Math.min(...p.boxes.map((b) => b.u0), rear.u - rear.r);
    const hi = Math.max(...p.boxes.map((b) => b.u1), front.u + front.r);
    assert.ok(hi - lo > 1.5 && hi - lo < 2.3, `${style}: ${hi - lo} m long`);
    for (const b of p.boxes) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1 && b.h0 >= 0, `${style} ${b.role} is a real box above ground`);
    assert.ok(Math.max(...p.boxes.map((b) => b.h1)) > 0.85);
  }
  assert.ok(scooterParts('motorbike').wheels[0].r > scooterParts('scooter').wheels[0].r, 'a motorbike has bigger wheels');
  assert.ok(scooterParts('motorbike').boxes.some((b) => b.role === 'metal'), 'an exhaust only on the motorbike');
  assert.ok(!scooterParts('scooter').boxes.some((b) => b.role === 'metal'));
});

test('size scales everything and clamps to 0.8..1.4', () => {
  const a = scooterParts('scooter', 1);
  const b = scooterParts('scooter', 1.4);
  assert.ok(Math.abs(b.wheels[1].r / a.wheels[1].r - 1.4) < 1e-9);
  assert.ok(Math.abs(b.tubes[0].a[1] / a.tubes[0].a[1] - 1.4) < 1e-9);
  assert.deepEqual(scooterParts('scooter', 9), b);
  assert.deepEqual(scooterParts('scooter', 0), a);
});

test('the colour and type options in the panel match the tables', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const opts = (id) => {
    const m = html.match(new RegExp(`id="${id}">(.*?)</select>`, 's'));
    assert.ok(m, `#${id} exists`);
    return [...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(opts('wScooterColour'), SCOOTER_CHOICES);
  assert.deepEqual(opts('wScooterStyle'), SCOOTER_STYLES);
});
