import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AWNING_COLOURS, awningColour, awningParts, awningSpacing, awningWidth, shopChance, signColour, signParts, signSpacing,
} from '../web/js/shopfront.js';

const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const jakarta = { lat: -6.17, lon: 106.82 };
const paris = { lat: 48.86, lon: 2.29 };
const nyc = { lat: 40.7, lon: -74 };

test('spacing depends on the place; Korea is not mistaken for Japan, and Paris is awning country', () => {
  assert.equal(awningSpacing(seoul), 22);
  assert.equal(awningSpacing(tokyo), 20);
  assert.equal(awningSpacing(paris), 14);
  assert.equal(awningSpacing(jakarta), 26);
  assert.equal(awningSpacing(nyc), 30);
  assert.equal(awningSpacing(null), 30);
  assert.ok(signSpacing(tokyo) < signSpacing(paris), 'Tokyo has far more signs than Paris');
  assert.ok(signSpacing(seoul) > signSpacing(tokyo) && signSpacing(seoul) < signSpacing(jakarta));
});

test('chance scales with density, clamps to 0..1 and treats junk as none', () => {
  assert.equal(shopChance(0, 14, 10), 0);
  assert.equal(shopChance(100, 20, 10), 0.5);
  assert.equal(shopChance(50, 20, 10), 0.25);
  assert.equal(shopChance(100, 5, 10), 1, 'cannot exceed certainty');
  assert.equal(shopChance(300, 20, 10), 0.5, 'density clamps at 100');
  assert.equal(shopChance('x', 20, 10), 0);
  assert.equal(shopChance(-4, 20, 10), 0);
});

test('a chosen awning colour wins; mixed and unknown choices pick by u across the whole palette', () => {
  assert.equal(awningColour('navy', 0.9), AWNING_COLOURS.navy);
  assert.equal(awningColour('toString', 0), AWNING_COLOURS.red, 'an inherited name is not a colour');
  const seen = new Set([0, 0.2, 0.4, 0.6, 0.8, 0.999].map((u) => awningColour('mixed', u)));
  assert.equal(seen.size, Object.keys(AWNING_COLOURS).length);
  assert.equal(awningColour('mixed', 1), awningColour('mixed', 0.999), 'u = 1 stays in range');
  assert.ok(signColour(1) && signColour(-1) && signColour(0.5));
});

test('awning width is 2..4.5 m, shrinks to fit the wall and is refused when it cannot fit', () => {
  assert.equal(awningWidth(0, 10), 2);
  assert.equal(awningWidth(1, 10), 4.5);
  assert.equal(awningWidth(2, 10), 4.5, 'u clamps');
  assert.equal(awningWidth(1, 3), 2.7, 'limited by the wall minus a margin');
  assert.equal(awningWidth(0.5, 1.8), null, 'under 1.6 m left');
  assert.ok(Math.abs(awningWidth(0.5, 2) - 1.7) < 1e-9);
});

test('an awning slopes from the wall down to the front edge, with a valance and alternating stripes', () => {
  const parts = awningParts({ width: 3, depth: 1.2, top: 3.2, drop: 0.5, valance: 0.2, stripes: 4 });
  const cloth = parts.filter((p) => p.role === 'cloth' || p.role === 'alt');
  assert.equal(parts.length, 12, 'cloth, underside and valance per stripe');
  const slopes = parts.filter((p) => p.quad[0][1] === 0 && p.role !== 'under');
  assert.equal(slopes.length, 4);
  for (const s of slopes) {
    assert.equal(s.quad[0][2], 3.2, 'top edge on the wall');
    assert.ok(Math.abs(s.quad[2][2] - 2.7) < 1e-9 && s.quad[2][1] === 1.2, 'front edge lower and out');
  }
  assert.deepEqual(slopes.map((s) => s.role), ['cloth', 'alt', 'cloth', 'alt']);
  const us = slopes.flatMap((s) => s.quad.map((q) => q[0]));
  assert.ok(Math.min(...us) === -1.5 && Math.max(...us) === 1.5, 'centred on the spot');
  const valance = parts.filter((p) => p.quad[0][1] === 1.2 && p.quad[0][2] === 2.7);
  assert.equal(valance.length, 4);
  assert.ok(valance.every((v) => Math.abs(v.quad[2][2] - 2.5) < 1e-9));
  assert.ok(cloth.length === 8);
  assert.equal(awningParts({ width: 2, depth: 1, top: 3, stripes: 0 }).length, 3, 'at least one stripe');
});

test('a blade sign has an arm out from the wall and a board at its end that spans the board width', () => {
  const parts = signParts({ width: 0.8, height: 1.2, out: 0.9, top: 4 });
  const arm = parts.find((p) => p.role === 'arm');
  assert.equal(arm.quad[2][1], 0.9);
  const board = parts.find((p) => p.role === 'board');
  const vs = board.quad.map((q) => q[1]);
  assert.ok(Math.abs(Math.min(...vs) - 0.5) < 1e-9 && Math.abs(Math.max(...vs) - 1.3) < 1e-9);
  const hs = board.quad.map((q) => q[2]);
  assert.ok(Math.abs(Math.max(...hs) - 3.92) < 1e-9 && Math.abs(Math.min(...hs) - 2.72) < 1e-9);
  assert.ok(board.quad.every((q) => q[0] === 0), 'the board lies in the plane across the arm');
});

test('the awning colour options in the panel match the awning table', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wAwningColour">(.*?)<\/select>/s);
  assert.ok(m, '#wAwningColour exists');
  const values = [...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(values, ['mixed', ...Object.keys(AWNING_COLOURS)]);
});

test('sign lettering bars sit just in front of both faces of the board, inside its edges and above its bottom', () => {
  const parts = signParts({ width: 0.8, height: 1.3, out: 0.9, top: 4 });
  const text = parts.filter((p) => p.role === 'text');
  assert.equal(text.length, 8, 'four lines (1.3 / 0.32), two faces each');
  assert.equal(text.filter((t) => t.quad[0][0] > 0).length, 4);
  const board = parts.find((p) => p.role === 'board').quad;
  const [vMin, vMax] = [Math.min(...board.map((q) => q[1])), Math.max(...board.map((q) => q[1]))];
  const [hMin, hMax] = [Math.min(...board.map((q) => q[2])), Math.max(...board.map((q) => q[2]))];
  for (const t of text) for (const [, v, h] of t.quad) assert.ok(v > vMin && v < vMax && h > hMin && h < hMax);
  assert.equal(signParts({ width: 0.8, height: 0.1, out: 0.9, top: 4 }).filter((p) => p.role === 'text').length, 2, 'a low board still gets one line');
});
