import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TAXI_CHOICES, TAXI_COLOURS, canBeTaxi, roofLight, taxiChance, taxiColour, taxiPlace } from '../web/js/taxis.js';

const nyc = { lat: 40.7, lon: -74 };
const london = { lat: 51.5, lon: -0.12 };
const tokyo = { lat: 35.66, lon: 139.7 };
const seoul = { lat: 37.56, lon: 126.98 };
const bangkok = { lat: 13.75, lon: 100.5 };
const jakarta = { lat: -6.2, lon: 106.8 };
const paris = { lat: 48.86, lon: 2.29 };

const drawn = (choice, c) => [...new Set(Array.from({ length: 80 }, (_, i) => taxiColour(choice, c, i / 80)))].sort();

test('each place has its own taxi colours', () => {
  assert.deepEqual(drawn('auto', nyc), [TAXI_COLOURS.yellow]);
  assert.deepEqual(drawn('auto', london), [TAXI_COLOURS.black]);
  assert.deepEqual(drawn('auto', tokyo), [TAXI_COLOURS.black, TAXI_COLOURS.green, TAXI_COLOURS.yellow].sort());
  assert.deepEqual(drawn('auto', seoul), [TAXI_COLOURS.orange, TAXI_COLOURS.white].sort());
  assert.deepEqual(drawn('auto', bangkok), [TAXI_COLOURS.green, TAXI_COLOURS.pink, TAXI_COLOURS.yellow].sort());
  assert.deepEqual(drawn('auto', jakarta), [TAXI_COLOURS.blue, TAXI_COLOURS.white].sort());
  assert.deepEqual(drawn('auto', paris), [TAXI_COLOURS.black, TAXI_COLOURS.white, TAXI_COLOURS.yellow].sort());
  assert.deepEqual(drawn('auto', null), drawn('auto', paris));
});

test('a chosen colour wins everywhere, unknown choices follow the place, the draw clamps', () => {
  assert.deepEqual(drawn('pink', nyc), [TAXI_COLOURS.pink]);
  assert.deepEqual(drawn('toString', nyc), drawn('auto', nyc));
  assert.equal(taxiColour('auto', tokyo, 9), taxiColour('auto', tokyo, 0.999));
  assert.equal(taxiColour('auto', tokyo, -1), taxiColour('auto', tokyo, 0));
});

test('taxi chance scales with the slider and the place, clamps, and bad input is none', () => {
  assert.equal(taxiChance(0, nyc), 0);
  assert.equal(taxiChance('x', nyc), 0);
  assert.ok(taxiChance(50, nyc) > taxiChance(50, london) && taxiChance(50, london) > taxiChance(50, tokyo) && taxiChance(50, tokyo) > taxiChance(50, paris));
  assert.ok(Math.abs(taxiChance(100, nyc) - 2 * taxiChance(50, nyc)) < 1e-12, 'linear in the slider');
  assert.equal(taxiChance(900, nyc), taxiChance(100, nyc));
  assert.ok(taxiChance(100, nyc) <= 0.9);
  assert.ok(taxiPlace(seoul).factor === taxiPlace(tokyo).factor && taxiPlace(seoul).colours !== taxiPlace(tokyo).colours, 'Korea is looked up before the wider Japan box');
});

test('only ordinary cars can be taxis', () => {
  assert.deepEqual(['sedan', 'compact', 'kei', 'suv', 'van', 'pickup', 'bus', undefined].map(canBeTaxi), [true, true, false, false, false, false, false, false]);
});

test('the roof light sits on the roof, is centred across the car and is wider than tall', () => {
  for (const roof of [1.4, 1.45, 1.6]) {
    const l = roofLight(roof);
    assert.equal(l.y0, roof);
    assert.ok(l.y1 > l.y0 && l.y1 - l.y0 < 0.25);
    assert.ok(Math.abs(l.x0 + l.x1) < 1e-12, 'centred across');
    assert.ok(l.z0 < l.z1 && l.z0 > -0.5 && l.z1 < 0.5, 'near the middle of the roof');
    assert.ok(l.x1 - l.x0 > l.y1 - l.y0);
  }
  assert.equal(roofLight().y0, 1.45);
});

test('the colour options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wTaxiColour">(.*?)<\/select>/s);
  assert.ok(m, '#wTaxiColour exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), TAXI_CHOICES);
});
