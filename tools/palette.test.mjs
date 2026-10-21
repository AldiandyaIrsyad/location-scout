import assert from 'node:assert/strict';
import test from 'node:test';
import { paletteFor } from '../web/js/palette.js';

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const isGrey = (hex) => { const [r, g, b] = rgb(hex); return b >= r && Math.max(r, g, b) - Math.min(r, g, b) <= 40; };
const generic = paletteFor({ lat: -6.1754, lon: 106.8272 });

test('only places inside the Paris ring road get the Paris palette', () => {
  const eiffel = paletteFor({ lat: 48.8584, lon: 2.2945 });
  assert.equal(eiffel.name, 'paris');
  assert.equal(paletteFor({ lat: 48.8606, lon: 2.3376 }), eiffel, 'the Louvre');
  assert.equal(paletteFor({ lat: 48.8049, lon: 2.1204 }).name, 'generic', 'Versailles is outside it');
  assert.equal(paletteFor({ lat: 48.8920, lon: 2.2380 }).name, 'paris', 'La Défense side of the ring road');
  assert.equal(paletteFor({ lat: 45.764, lon: 4.8357 }).name, 'generic', 'Lyon');
  assert.equal(generic.name, 'generic');
});

test('a missing or invalid centre falls back to the generic palette', () => {
  for (const center of [null, undefined, {}, { lat: NaN, lon: 2.3 }, { lat: 48.85, lon: undefined }]) {
    assert.equal(paletteFor(center), generic);
  }
});

test('Paris roofs are mostly zinc grey, walls are pale limestone, and untouched kinds keep the generic colours', () => {
  const paris = paletteFor({ lat: 48.8584, lon: 2.2945 });
  assert.ok(paris.roofs.filter(isGrey).length >= paris.roofs.length * 0.75, 'zinc and slate dominate');
  assert.ok(paris.roofs.some((hex) => !isGrey(hex)), 'a few tile roofs remain for variety');
  for (const kind of ['house', 'residential', 'apartments', 'commercial', 'retail', 'default']) {
    for (const hex of paris.walls[kind]) {
      const [r, g, b] = rgb(hex);
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      assert.ok(luma >= 0.75 && r >= g && g >= b, `${kind} ${hex} is a warm pale stone`);
    }
  }
  assert.deepEqual(paris.walls.industrial, generic.walls.industrial);
  assert.deepEqual(paris.walls.office, generic.walls.office);
  assert.notDeepEqual(paris.roofs, generic.roofs);
});

test('every palette colour is a six-digit hex', () => {
  for (const center of [{ lat: 48.8584, lon: 2.2945 }, { lat: 0, lon: 0 }]) {
    const palette = paletteFor(center);
    const colors = [...palette.roofs, ...Object.values(palette.walls).flat()];
    assert.ok(colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)), `${palette.name} has a malformed colour`);
  }
});
