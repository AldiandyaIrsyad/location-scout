import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BARRIER_GROUPS, BARRIER_STYLES } from '../web/js/barriers.js';
import {
  BENCH_COLORS, BENCH_STYLES, benchColor, benchWear, BIN_STYLES, ROOF_COLORS, WALL_TONES, benchParts, roofColors, roofShapeFor, wallColors,
} from '../web/js/scenestyle.js';
import { paletteFor } from '../web/js/palette.js';

const paris = paletteFor({ lat: 48.8584, lon: 2.2945 });
const base = { mapped: undefined, style: 'auto', height: 12, plain: false, solid: false };
const shape = (over) => roofShapeFor({ ...base, ...over });

test('"as mapped" keeps the map roof and ignores shapes it cannot build', () => {
  assert.equal(shape({ mapped: 'gabled' }), 'gabled');
  assert.equal(shape({ mapped: 'hipped' }), 'hipped');
  assert.equal(shape({ mapped: 'many' }), null, 'an unknown tag keeps the mapped cap');
  assert.equal(shape({}), null);
});

test('"all flat" flattens even mapped pitched roofs', () => {
  assert.equal(shape({ style: 'flat', mapped: 'gabled' }), null);
});

test('a chosen pitched roof goes on ordinary low buildings, mapped or not', () => {
  assert.equal(shape({ style: 'hipped' }), 'hipped');
  assert.equal(shape({ style: 'hipped', mapped: 'gabled' }), 'hipped', 'the choice wins over the tag');
});

test('a chosen roof never goes where a procedural roof cannot work or does not belong', () => {
  assert.equal(shape({ style: 'gabled', plain: true, mapped: 'gabled' }), null, 'courtyards, surroundings and low-poly stay flat');
  assert.equal(shape({ style: 'gabled', solid: true }), null, 'a monument gets no chosen roof');
  assert.equal(shape({ style: 'gabled', solid: true, mapped: 'pyramidal' }), 'pyramidal', 'but keeps the one it is mapped with');
  assert.equal(shape({ style: 'gabled', height: 80 }), null, 'a tower keeps its flat top');
  assert.equal(shape({ style: 'gabled', height: 80, mapped: 'hipped' }), 'hipped');
  assert.equal(shape({ style: 'gabled', height: 30 }), 'gabled', '30 m is still an ordinary building');
});

test('roof and wall colours fall back to the place palette for auto and unknown choices', () => {
  assert.equal(roofColors(paris, 'auto'), paris.roofs);
  assert.equal(roofColors(paris, 'nonsense'), paris.roofs);
  assert.equal(roofColors(paris, 'slate'), ROOF_COLORS.slate);
  assert.equal(wallColors(paris, 'house', 'auto'), paris.walls.house);
  assert.equal(wallColors(paris, 'no-such-kind', 'auto'), paris.walls.default);
  assert.equal(wallColors(paris, 'house', 'brick'), WALL_TONES.brick);
  assert.equal(wallColors(paris, 'house', 'toString'), paris.walls.house, 'an inherited property name is not a tone');
  assert.equal(roofColors(paris, 'constructor'), paris.roofs);
});

test('an unknown bench colour is wood', () => {
  assert.equal(benchColor('black'), BENCH_COLORS.black);
  assert.equal(benchColor('toString'), BENCH_COLORS.wood);
  assert.equal(benchColor(undefined), BENCH_COLORS.wood);
});

test('every chosen colour is a six-digit hex', () => {
  const all = [...Object.values(ROOF_COLORS).flat(), ...Object.values(WALL_TONES).flat(), ...Object.values(BENCH_COLORS)];
  assert.ok(all.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
});

test('every bench style is a set of well-formed boxes, and unknown styles draw a park bench', () => {
  for (const style of BENCH_STYLES) {
    const parts = benchParts(style);
    assert.ok(parts.length > 0, style);
    for (const p of parts) {
      assert.ok(p.u0 < p.u1 && p.v0 < p.v1 && p.h0 < p.h1, `${style} has a degenerate box`);
      assert.ok(['seat', 'frame', 'stone'].includes(p.role), `${style} role ${p.role}`);
      assert.ok(p.h0 >= 0 && p.h1 < 1.2, `${style} stays bench-sized`);
    }
  }
  assert.deepEqual(benchParts('mystery'), benchParts('park'));
});

test('bench styles differ in the way their names say', () => {
  const top = (s) => Math.max(...benchParts(s).map((p) => p.h1));
  assert.ok(top('park') > 0.8, 'a park bench has a back');
  assert.ok(top('backless') < 0.5, 'a backless bench does not');
  assert.ok(benchParts('stone').every((p) => p.role === 'stone'), 'stone ignores the bench colour');
  assert.equal(benchParts('picnic').filter((p) => p.h0 > 0.7).length, 1, 'one table top above the seats');
  assert.ok(benchParts('picnic').some((p) => p.u1 <= -0.4) && benchParts('picnic').some((p) => p.u0 >= 0.4), 'a seat on each side of the table');
});

test('every barrier kind belongs to a panel switch', () => {
  for (const kind of Object.keys(BARRIER_STYLES)) assert.match(BARRIER_GROUPS[kind] || '', /^barrier(Fences|Walls|Hedges)$/, kind);
});

// The panel's options must be exactly the styles the code knows, or a choice would silently do nothing.
test('the options in the panel match the style tables', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const optionsOf = (id) => {
    const m = html.match(new RegExp(`id="${id}">(.*?)</select>`, 's'));
    assert.ok(m, `#${id} exists`);
    return [...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(optionsOf('wRoofColor'), ['auto', ...Object.keys(ROOF_COLORS)]);
  assert.deepEqual(optionsOf('wWallTone'), ['auto', ...Object.keys(WALL_TONES)]);
  assert.deepEqual(optionsOf('wBenchColor'), Object.keys(BENCH_COLORS));
  assert.deepEqual(optionsOf('wBenchStyle'), BENCH_STYLES);
  assert.deepEqual(optionsOf('wBinStyle'), BIN_STYLES);
  assert.deepEqual(optionsOf('wRoofStyle'), ['auto', 'flat', 'gabled', 'hipped', 'pyramidal']);
});

const stream = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('a new bench has no wear at all, whatever the random stream says', () => {
  assert.deepEqual(benchWear(0, stream(0.9)), { seatShift: 0, rust: 0, stains: [] });
  assert.deepEqual(benchWear(-20, stream(0.9)), { seatShift: 0, rust: 0, stains: [] }, 'below 0 counts as new');
  assert.deepEqual(benchWear('old', stream(0.9)), { seatShift: 0, rust: 0, stains: [] }, 'not a number counts as new');
});

test('wear grows the shift, rust and stain count, and stays inside its ranges', () => {
  const worn = benchWear(100, stream(1, 1, 0.5, 0.5, 0.5, 0.5, 0.5));
  assert.ok(Math.abs(worn.seatShift) <= 0.175 + 1e-9);
  assert.ok(worn.rust > 0 && worn.rust <= 0.6 + 1e-9);
  assert.equal(worn.stains.length, 4, 'full wear with the highest roll: 1 + 3 stains');
  for (const st of worn.stains) {
    assert.ok(Math.abs(st.u) <= 0.7 && Math.abs(st.v) <= 0.85, 'stains stay on the seat');
    assert.ok(st.w >= 0.12 && st.w <= 0.42 && st.l >= 0.06 && st.l <= 0.26);
  }
  const light = benchWear(20, stream(0.5, 0, 0.5, 0.5, 0.5));
  assert.ok(light.stains.length <= worn.stains.length);
  assert.ok(light.rust < worn.rust, 'a lightly worn bench rusts less');
  assert.equal(benchWear(500, stream(0.5)).stains.length, benchWear(100, stream(0.5)).stains.length, 'clamped at 100');
});

test('the same bench stream always gives the same wear', () => {
  assert.deepEqual(benchWear(60, stream(0.1, 0.9, 0.3, 0.7)), benchWear(60, stream(0.1, 0.9, 0.3, 0.7)));
});
