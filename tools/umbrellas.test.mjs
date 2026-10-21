import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { UMBRELLA_CHOICES, UMBRELLA_COLOURS, hasUmbrella, umbrellaColour, umbrellaParts } from '../web/js/umbrellas.js';

test('share is a percentage of figures: none at 0, all at 100, and the cut falls where the share says', () => {
  const draws = Array.from({ length: 100 }, (_, i) => i / 100);
  assert.equal(draws.filter((u) => hasUmbrella(0, u)).length, 0);
  assert.equal(draws.filter((u) => hasUmbrella(100, u)).length, 100);
  assert.equal(draws.filter((u) => hasUmbrella(35, u)).length, 35);
  assert.equal(hasUmbrella(900, 0.99), true, 'over 100 clamps');
  assert.equal(hasUmbrella(-5, 0), false, 'negative clamps to none');
  assert.equal(hasUmbrella('x', 0), false);
});

test('colour: a named one is fixed, mixed favours black and clear but reaches every colour, unknown is mixed', () => {
  assert.equal(umbrellaColour('red', 0.5), UMBRELLA_COLOURS.red);
  const mixed = Array.from({ length: 100 }, (_, i) => umbrellaColour('mixed', i / 100));
  assert.equal(new Set(mixed).size, Object.keys(UMBRELLA_COLOURS).length);
  const count = (c) => mixed.filter((x) => x === c).length;
  assert.ok(count(UMBRELLA_COLOURS.black) > count(UMBRELLA_COLOURS.red) * 2);
  assert.ok(count(UMBRELLA_COLOURS.clear) > count(UMBRELLA_COLOURS.pink));
  assert.equal(umbrellaColour('toString', 0.3), umbrellaColour('mixed', 0.3));
  assert.equal(umbrellaColour('mixed', 9), umbrellaColour('mixed', 0.999));
});

test('the canopy is over the head and the pole joins the hand to the top of the canopy', () => {
  for (const size of [0.7, 1, 1.5]) {
    const p = umbrellaParts(size);
    assert.ok(p.canopy.y > 1.75, 'rim clears the head (about 1.7 m)');
    assert.ok(p.canopy.r > 0.3 && p.canopy.h > 0 && p.canopy.h < p.canopy.r);
    assert.deepEqual(p.pole.to, [p.canopy.x, p.canopy.y + p.canopy.h, p.canopy.z]);
    assert.ok(p.pole.from[1] > 0.6 && p.pole.from[1] < 1.2, 'held at hand height');
    assert.ok(Math.abs(p.pole.from[0]) > 0.15, 'held out to the side of the body');
  }
});

test('size scales the canopy and clamps to 0.7..1.5', () => {
  assert.ok(Math.abs(umbrellaParts(1.5).canopy.r / umbrellaParts(1).canopy.r - 1.5) < 1e-9);
  assert.deepEqual(umbrellaParts(9), umbrellaParts(1.5));
  assert.deepEqual(umbrellaParts(0), umbrellaParts(1));
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wUmbrellaColour">(.*?)<\/select>/s);
  assert.ok(m, '#wUmbrellaColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), UMBRELLA_CHOICES);
});
