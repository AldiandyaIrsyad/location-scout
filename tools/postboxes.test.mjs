import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { POSTBOX_COLOURS, POSTBOX_STYLES, postboxChance, postboxColour, postboxParts, postboxSpacing, postboxStyleFor } from '../web/js/postboxes.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const paris = { lat: 48.86, lon: 2.29 };
const london = { lat: 51.5, lon: -0.12 };
const nyc = { lat: 40.7, lon: -74 };

test('auto style by place: cylinders in Japan and Korea, boxes in France, pillars elsewhere; a chosen style wins', () => {
  assert.deepEqual([tokyo, seoul, paris, london, nyc, null].map((c) => postboxStyleFor('auto', c)), ['cylinder', 'cylinder', 'box', 'pillar', 'pillar', 'pillar']);
  assert.equal(postboxStyleFor('pillar', tokyo), 'pillar');
  assert.equal(postboxStyleFor('toString', paris), 'box');
});

test('colour: yellow boxes in France, blue ones elsewhere, red cylinders and pillars', () => {
  assert.equal(postboxColour('box', paris), POSTBOX_COLOURS.yellow);
  assert.equal(postboxColour('box', nyc), POSTBOX_COLOURS.blue);
  assert.equal(postboxColour('cylinder', tokyo), POSTBOX_COLOURS.red);
  assert.equal(postboxColour('pillar', london), POSTBOX_COLOURS.red);
});

test('spacing and chance', () => {
  assert.ok(postboxSpacing(tokyo) < postboxSpacing(paris));
  assert.equal(postboxChance(100, 50, 10), 0.2);
  assert.equal(postboxChance(0, 50, 10), 0);
  assert.equal(postboxChance(100, 5, 10), 1);
  assert.equal(postboxChance(900, 50, 10), 0.2);
  assert.equal(postboxChance('x', 50, 10), 0);
});

test('every design stands on the ground, is about a metre and a bit tall and has a slot on its front', () => {
  for (const style of ['cylinder', 'pillar', 'box']) {
    const p = postboxParts(style, 1);
    const lows = [...p.boxes.map((b) => b.h0), ...(p.cyl ? [p.cyl.h0] : [])];
    const highs = [...p.boxes.map((b) => b.h1), ...(p.cyl ? [p.cyl.h1] : [])];
    assert.equal(Math.min(...lows), 0, `${style} stands on the ground`);
    assert.ok(Math.max(...highs) > 1.1 && Math.max(...highs) < 1.6, `${style}: ${Math.max(...highs)} m`);
    const slot = p.boxes.find((b) => b.role === 'slot');
    assert.ok(slot && slot.v0 > 0.1, `${style}: a slot on the front (+v)`);
    for (const b of p.boxes) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1);
  }
  assert.ok(postboxParts('cylinder').cyl.r > 0.2);
  assert.equal(postboxParts('pillar').cyl, null);
  assert.ok(!postboxParts('box').boxes.every((b) => b.h0 === 0), 'the letter box is on legs');
});

test('size scales everything and clamps to 0.7..1.5', () => {
  const a = postboxParts('pillar', 1);
  const b = postboxParts('pillar', 1.5);
  assert.ok(Math.abs(Math.max(...b.boxes.map((x) => x.h1)) / Math.max(...a.boxes.map((x) => x.h1)) - 1.5) < 1e-9);
  assert.deepEqual(postboxParts('pillar', 9), postboxParts('pillar', 1.5));
  assert.deepEqual(postboxParts('pillar', 0), postboxParts('pillar', 1));
  assert.ok(Math.abs(postboxParts('cylinder', 1.5).cyl.r / postboxParts('cylinder', 1).cyl.r - 1.5) < 1e-9);
});

test('the style options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wPostStyle">(.*?)<\/select>/s);
  assert.ok(m, '#wPostStyle exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), POSTBOX_STYLES);
});
