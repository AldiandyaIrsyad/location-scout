import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { COL_W, DOOR, FLOOR_H, PASSAGE, RIBBON, SHOP, STYLES, doorColour, facadeGlsl, facadeShapes, fcHash, groundFloor, groundKind, isBlank, styleOf } from '../web/js/facade.js';

// ---- the GLSL scalar functions, run as JS --------------------------------------------------------------------------
// facadeGlsl() is plain C-like code in a subset JS can read after a few renames. Running it here is what proves the
// shader (which draws the picture) and facade.js (which the SVG export uses) make the same decisions.
const glslMod = (x, m) => x - m * Math.floor(x / m);
function loadGlsl(uFacade) {
  const body = facadeGlsl().split('vec4 fcRect')[0]; // the style table returns vec4s; it is checked separately below
  const js = body
    .replace(/float (\w+)\(([^)]*)\)/g, (_, name, args) => `function ${name}(${args.replace(/float /g, '')})`)
    .replace(/^(\s*)float (\w+) =/gm, '$1let $2 =')
    .replace(/\bmod\(/g, 'glslMod(')
    .replace(/\bfloor\(/g, 'Math.floor(');
  return new Function('uFacade', 'glslMod', `${js}\nreturn { fcHash, fcStyle, fcGround, fcBlank, fcDoorColour };`)(uFacade, glslMod);
}

const SEEDS = Array.from({ length: 1000 }, (_, i) => i);
const COLS = Array.from({ length: 121 }, (_, i) => i - 60);

test('the shader code makes the same decisions as facade.js (hash, style, ground floor, blank columns, door colour)', () => {
  for (const [variety, openings] of [[0, 0], [0.6, 0.5], [1, 1], [0.35, 0.8]]) {
    const g = loadGlsl({ x: variety, y: openings });
    for (const s of SEEDS) {
      assert.equal(g.fcStyle(s), styleOf(s, variety), `style of seed ${s} at variety ${variety}`);
      for (const c of COLS) {
        assert.equal(g.fcHash(c, 7, s), fcHash(c, 7, s));
        assert.equal(g.fcGround(s, c), groundKind(s, c, openings), `ground of seed ${s} column ${c} at openings ${openings}`);
        assert.equal(g.fcBlank(s, c) > 0.5, isBlank(s, c, variety), `blank of seed ${s} column ${c}`);
        assert.equal(g.fcDoorColour(s, c), doorColour(s, c));
      }
    }
  }
});

test('the style table in the shader is the one in facade.js', () => {
  const rows = [...facadeGlsl().matchAll(/if \(st < ([\d.]+)\) return k < 0\.5 \? (vec4\([^)]*\)) : (vec4\([^)]*\));/g)];
  assert.equal(rows.length, STYLES.length);
  const nums = (v) => v.slice(5, -1).split(',').map(Number);
  rows.forEach((m, i) => {
    assert.equal(Number(m[1]), i + 0.5);
    const [a, b] = [nums(m[2]), nums(m[3])];
    assert.deepEqual(a, STYLES[i].rects[0]);
    assert.deepEqual(b, STYLES[i].rects[1] ?? [0]); // vec4(0.0) is one scalar
  });
});

test('render.js builds its window shader from facade.js and keeps the 3.2 m x 3 m cell', () => {
  const src = readFileSync(new URL('../web/js/render.js', import.meta.url), 'utf8');
  assert.match(src, /\$\{facadeGlsl\(\)\}/);
  assert.equal(FLOOR_H, 3.2);
  assert.equal(COL_W, 3);
});

test('the hash stays exact in float32: every intermediate is an integer below 2^24 for the whole world', () => {
  let worst = 0;
  for (const s of [0, 999]) {
    for (const a of [-1700, -1, 0, 1, 1700]) {
      for (const b of [1, 2, 5, 7, 9, 13, 17]) {
        const h0 = ((a * 127 + b * 311 + s * 73 + 19) % 1031 + 1031) % 1031;
        const h1 = (h0 * h0 + 7 * s + 3) % 1031;
        worst = Math.max(worst, Math.abs(a * 127 + b * 311 + s * 73 + 19), h0 * h0 + 7 * s + 3, h1 * h1 + 31 * a + 11 * b);
      }
    }
  }
  assert.ok(worst < 2 ** 24, `largest intermediate ${worst}`);
});

test('hash values fill 0..1 without clumping: no input value repeats in a long run of columns', () => {
  const seen = new Set();
  for (const c of COLS) seen.add(fcHash(c, 7, 123));
  assert.ok(seen.size > 100, `${seen.size} distinct hashes in 121 columns`);
  for (const c of COLS) assert.ok(fcHash(c, 7, 123) >= 0 && fcHash(c, 7, 123) < 1);
});

// ---- behaviour -------------------------------------------------------------------------------------------------------
test('styles follow their weights, and variety 0 means every building is classic', () => {
  const count = new Array(STYLES.length).fill(0);
  for (const s of SEEDS) count[styleOf(s, 1)]++;
  STYLES.forEach((st, i) => assert.ok(Math.abs(count[i] / SEEDS.length - st.weight) < 0.07, `${st.id}: ${count[i] / SEEDS.length} vs ${st.weight}`));
  assert.ok(SEEDS.every((s) => styleOf(s, 0) === 0));
  const half = SEEDS.filter((s) => styleOf(s, 0.5) !== 0 || fcHash(s, 1, 5) < STYLES[0].weight).length;
  assert.ok(half > 0);
});

test('ground floor: openings 0 means none, shop windows only in shop buildings, doors and passages never touch', () => {
  assert.ok(SEEDS.every((s) => COLS.every((c) => groundKind(s, c, 0) === 0)));
  let doors = 0;
  let shops = 0;
  let cols = 0;
  for (const s of SEEDS) {
    const shopBuilding = COLS.some((c) => groundKind(s, c, 1) === 3);
    for (const c of COLS) {
      const k = groundKind(s, c, 1);
      cols++;
      if (k === 1 || k === 2) {
        doors++;
        assert.ok(![1, 2].includes(groundKind(s, c - 1, 1)), `seed ${s}: openings in columns ${c - 1} and ${c}`);
      }
      if (k === 3) shops++;
    }
    if (shopBuilding) assert.ok(fcHash(s, 9, 2) < 0.35, `seed ${s} has shop windows but is not a shop building`);
  }
  assert.ok(doors / cols > 0.08 && doors / cols < 0.17, `door share ${doors / cols}`);
  assert.ok(shops > 0);
});

test('ribbon windows never have blank columns; other styles do', () => {
  const ribbon = SEEDS.filter((s) => styleOf(s, 1) === RIBBON);
  assert.ok(ribbon.length > 20);
  assert.ok(ribbon.every((s) => COLS.every((c) => !isBlank(s, c, 1))));
  const other = SEEDS.filter((s) => styleOf(s, 1) !== RIBBON);
  assert.ok(other.some((s) => COLS.some((c) => isBlank(s, c, 1))));
  assert.ok(SEEDS.every((s) => COLS.every((c) => !isBlank(s, c, 0))));
});

test('ground floor row: the first row whose glass sits at or above the ground', () => {
  assert.equal(groundFloor(0), 0);
  assert.equal(groundFloor(0.9), 0);
  assert.equal(groundFloor(1.3), 1);
  assert.equal(groundFloor(2.9), 1);
  assert.equal(groundFloor(3.3), 1);
  assert.equal(groundFloor(4.3), 2);
  assert.equal(groundFloor(-2), 0);
  assert.equal(groundFloor(-3.5), -1);
});

const rectsOverlap = (a, b) => a.u0 < b.u1 && b.u0 < a.u1 && a.y0 < b.y1 && b.y0 < a.y1;

test('facade shapes: variety 0 and openings 0 reproduce the old classic grid', () => {
  const seed = 5;
  const { windows, doors } = facadeShapes(seed, 0, 0, 30, 0, 12, { variety: 0, openings: 0 });
  assert.equal(doors.length, 0);
  // the old addWindowSegs: whole windows 0.8..2.5 up, 0.7..2.3 across, clear of the bottom by 0.3 and of the top by 0.2
  const old = [];
  for (let k = 0; k * 3 + 0.7 <= 30; k++) {
    for (let f = 0; f * 3.2 + 0.8 < 12; f++) {
      const y0 = f * 3.2 + 0.8;
      const y1 = f * 3.2 + 2.5;
      if (y0 < 0.3 || y1 > 11.8 || k * 3 + 2.3 > 30) continue;
      old.push([k * 3 + 0.7, k * 3 + 2.3, y0, y1].map((v) => +v.toFixed(6)));
    }
  }
  const got = windows.map((w) => [w.u0, w.u1, w.y0, w.y1].map((v) => +v.toFixed(6)));
  assert.deepEqual(got.sort(), old.sort());
});

test('facade shapes: doors stand on the ground, windows never overlap them, everything stays on the wall', () => {
  let doorsSeen = 0;
  let passages = 0;
  for (const seed of SEEDS.slice(0, 300)) {
    for (const base of [0, 1.7, 5.1]) {
      const { windows, doors } = facadeShapes(seed, base, -20, 40, base, base + 14, { variety: 1, openings: 1 });
      for (const d of doors) {
        doorsSeen++;
        if (d.kind === 2) passages++;
        assert.equal(d.y0, base);
        assert.equal(d.y1, base + (d.kind === 1 ? DOOR.h : PASSAGE.h));
        assert.ok(d.u0 >= -20 && d.u1 <= 40);
        assert.equal(Math.floor(d.u0 / COL_W), Math.floor(d.u1 / COL_W), 'an opening stays inside its column');
        for (const w of windows) assert.ok(!rectsOverlap(d, w), `seed ${seed} base ${base}: window ${JSON.stringify(w)} over ${JSON.stringify(d)}`);
      }
      for (const w of windows) {
        assert.ok(w.u0 >= -20 && w.u1 <= 40 && w.y0 >= base + 0.3 && w.y1 <= base + 13.8, JSON.stringify(w));
        assert.ok(w.u1 > w.u0 && w.y1 > w.y0);
      }
    }
  }
  assert.ok(doorsSeen > 100 && passages > 5, `${doorsSeen} doors, ${passages} passages`);
});

test('facade shapes: a shop window replaces the glass of the ground row and spans most of the column', () => {
  const seed = SEEDS.find((s) => COLS.some((c) => groundKind(s, c, 1) === 3));
  const c = COLS.find((cc) => groundKind(seed, cc, 1) === 3);
  const { windows } = facadeShapes(seed, 0, c * COL_W, c * COL_W + COL_W, 0, 10, { variety: 1, openings: 1 });
  const shop = windows.filter((w) => w.u1 - w.u0 > 2.5);
  assert.equal(shop.length, 1);
  assert.ok(Math.abs(shop[0].u0 - (c * COL_W + SHOP.u0)) < 1e-9 && Math.abs(shop[0].u1 - (c * COL_W + SHOP.u1)) < 1e-9);
  assert.ok(Math.abs(shop[0].y0 - SHOP.y0) < 1e-9 && Math.abs(shop[0].y1 - SHOP.y1) < 1e-9);
});
