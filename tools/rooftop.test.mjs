import assert from 'node:assert/strict';
import test from 'node:test';
import { TANK_COLOURS, itemSize, parapetStrips, placeOnRoof, roofAxis, rooftopPlan, tankColour } from '../web/js/rooftop.js';
import { readFileSync } from 'node:fs';

const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const rect = [[0, 0], [20, 0], [20, 10], [0, 10]];

test('small, low or switched-off roofs get nothing', () => {
  const none = { ac: 0, tank: false, stair: false, mast: false };
  assert.deepEqual(rooftopPlan(() => 0, { area: 200, height: 12, amount: 0 }), none);
  assert.deepEqual(rooftopPlan(() => 0, { area: 30, height: 12, amount: 100 }), none, 'a shed footprint');
  assert.deepEqual(rooftopPlan(() => 0, { area: 200, height: 5, amount: 100 }), none, 'a low roof');
  assert.deepEqual(rooftopPlan(() => 0, { area: NaN, height: 12, amount: 100 }), none);
  assert.deepEqual(rooftopPlan(() => 0, { area: 200, height: 12, amount: 'x' }), none);
});

test('a bigger roof and a higher amount get more units, capped at ten', () => {
  const ac = (area, amount) => rooftopPlan(() => 0, { area, height: 20, amount }).ac;
  assert.equal(ac(140, 100), 2);
  assert.equal(ac(700, 100), 10);
  assert.equal(ac(5000, 100), 10, 'capped');
  assert.ok(ac(700, 50) < ac(700, 100));
  assert.equal(ac(700, 400), ac(700, 100), 'amount clamps at 100');
});

test('tank, stairwell and mast depend on size, height and the random stream', () => {
  const plan = (u, area, height) => rooftopPlan(() => u, { area, height, amount: 100 });
  assert.deepEqual([plan(0, 200, 12).tank, plan(0, 200, 12).stair, plan(0, 200, 12).mast], [true, true, true]);
  assert.deepEqual([plan(0.99, 200, 12).tank, plan(0.99, 200, 12).stair, plan(0.99, 200, 12).mast], [false, false, false]);
  assert.equal(plan(0, 100, 12).tank, false, 'too little roof for a tank (needs 120 m2)');
  assert.equal(plan(0, 100, 12).stair, true);
  assert.equal(plan(0, 200, 9.5).tank, false, 'too low for a tank');
  assert.equal(plan(0, 80, 12).stair, false, 'too little roof for a stairwell box (needs 90 m2)');
});

test('tank colour: a chosen one wins; auto and unknown choices cover the palette by u', () => {
  assert.equal(tankColour('blue', 0), TANK_COLOURS.blue);
  assert.equal(tankColour('toString', 0), TANK_COLOURS.green, 'an inherited name is not a colour');
  assert.equal(new Set([0, 0.3, 0.6, 0.99].map((u) => tankColour('auto', u))).size, 4);
  assert.equal(tankColour('auto', 1), tankColour('auto', 0.99));
});

test('item sizes come from their ranges', () => {
  assert.deepEqual(itemSize('stair', () => 0), { w: 2.4, d: 2.6, h: 2.4 });
  const tank = itemSize('tank', () => 1);
  assert.ok(near(tank.w, 2.8) && near(tank.w, tank.d) && near(tank.h, 2.7));
  assert.ok(itemSize('ac', () => 0).h < itemSize('ac', () => 1).h);
  assert.deepEqual(itemSize('nope', () => 0), { w: 1, d: 1, h: 1 });
});

test('the roof axis follows the longest edge', () => {
  assert.deepEqual(roofAxis(rect), { ux: 1, uy: 0 });
  const a = roofAxis([[0, 0], [3, 4], [-1, 8]].concat([[-4, 4]]));
  assert.ok(near(Math.hypot(a.ux, a.uy), 1));
});

test('boxes land inside the roof, clear of the edge and of each other, and a roof too small refuses', () => {
  const placed = [];
  const rand = seq(0.5, 0.5, 0.2, 0.3, 0.8, 0.7, 0.1, 0.9, 0.4, 0.6);
  const a = placeOnRoof(rect, rand, 2, 1, placed, { margin: 1 });
  assert.ok(a && a.x >= 2 && a.x <= 18 && a.y >= 1.5 && a.y <= 8.5, `centre ${JSON.stringify(a)} keeps the box 1 m from the edge`);
  assert.equal(placed.length, 1);
  const b = placeOnRoof(rect, rand, 2, 1, placed, { margin: 1 });
  assert.ok(b);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= placed[0].r + placed[1].r, 'no overlap');
  assert.equal(placeOnRoof(rect, rand, 30, 5, [], { margin: 1 }), null, 'a box longer than the roof');
  assert.equal(placeOnRoof(rect, rand, 2, 1, [{ x: 10, y: 5, r: 1000 }], { margin: 0.5 }), null, 'covered by an earlier item');
});

test('an L-shaped roof keeps boxes out of the notch', () => {
  const L = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
  let u = 0;
  const rand = () => (u = (u * 7919 + 0.137) % 1);
  for (let i = 0; i < 20; i++) {
    const p = placeOnRoof(L, rand, 1.5, 1, [], { margin: 0.6 });
    if (!p) continue;
    assert.ok(p.x < 5 || p.y < 5, `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) lies in the notch`);
  }
});

test('parapet strips run inside each edge whichever way the ring is wound', () => {
  for (const ring of [rect, [...rect].reverse()]) {
    const strips = parapetStrips(ring, 0.3);
    assert.equal(strips.length, 4);
    for (const q of strips) {
      const mx = (q[2][0] + q[3][0]) / 2;
      const my = (q[2][1] + q[3][1]) / 2;
      assert.ok(mx > 0 && mx < 20 && my > 0 && my < 10, 'the inner edge lies inside the roof');
      assert.ok(near(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), 0.3), 'strip is as thick as asked');
    }
  }
  assert.equal(parapetStrips([[0, 0], [0.2, 0], [0.2, 5], [0, 5]], 0.3).length, 2, 'edges under 0.3 m are skipped');
});

test('the tank colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wRoofTank">(.*?)<\/select>/s);
  assert.ok(m, '#wRoofTank exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), ['auto', ...Object.keys(TANK_COLOURS)]);
});
