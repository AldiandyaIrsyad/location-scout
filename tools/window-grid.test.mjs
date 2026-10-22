import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { columnCentre, slabHeights } from '../web/js/balconies.js';
import { gapCentre, unitHeights, acParts } from '../web/js/acunits.js';
import { shutterParts, shutterRows } from '../web/js/shutters.js';
import { plateCentre, plateParts } from '../web/js/streetnames.js';
import { trimBands } from '../web/js/walltrim.js';
import { COL_W, FLOOR_H, STYLES } from '../web/js/facade.js';

// The wall furniture modules place things on the shader's window grid by hard-coded numbers (3.2 m floors, 3 m columns,
// glass 0.8..2.5 m up and 0.7..2.3 m across: the "classic" window style of facade.js). If the grid in render.js or the
// classic style ever changes, these tests say which module is stale.
const src = readFileSync(new URL('../web/js/render.js', import.meta.url), 'utf8');
const glsl = src.slice(src.indexOf('const WINDOW_GLSL = `'), src.indexOf('float windowFade'));
const [colLo, colHi, rowLo, rowHi] = STYLES[0].rects[0];
const floorH = FLOOR_H;
const colW = COL_W;
const halfGlass = (colHi - colLo) / 2;
const colMid = (colHi + colLo) / 2;

test('the grid the modules assume is the one the shader draws', () => {
  assert.equal(STYLES[0].id, 'classic');
  assert.equal(STYLES[0].rects.length, 1);
  assert.deepEqual([floorH, colW, rowLo, rowHi, colLo, colHi], [3.2, 3, 0.8, 2.5, 0.7, 2.3]);
  assert.ok(glsl.includes('floor(p.y / 3.2)') && glsl.includes('floor(u / 3.0)'), 'the shader cell is still 3.2 m x 3 m');
  assert.ok(!/mod\(p\.y, 3\.2\)/.test(glsl), 'no second, hard-coded copy of the old grid');
});

test('balcony columns are centred on the glass of a column', () => {
  for (const u of [-10.2, -3, -0.1, 0, 0.1, 2.9, 3, 17.4]) {
    const c = columnCentre(u);
    assert.ok(Math.abs(((c % colW) + colW) % colW - colMid) < 1e-9, `${u}: centre ${c}`);
    assert.ok(Math.floor(c / colW) === Math.floor(u / colW), 'in the column the point is in');
  }
});

test('air-conditioner gaps are the bare strips between glass columns', () => {
  for (const u of [-10.2, -1.4, 0.2, 1.4, 5.3, 29]) {
    const g = gapCentre(u);
    assert.equal(((g % colW) + colW) % colW, 0, `${u}: gap at ${g}`);
    const inCol = ((g % colW) + colW) % colW;
    assert.ok(inCol < colLo || inCol > colHi, 'not on glass');
  }
});

test('air-conditioner and balcony heights follow the floor spacing from the absolute world height', () => {
  for (const ground of [0, 1.3, 40.6]) {
    for (const base of unitHeights(ground, 30, () => 0, 1)) assert.ok(Math.abs(((base - 1.0) / floorH) - Math.round((base - 1.0) / floorH)) < 1e-9, `AC base ${base}`);
    for (const slab of slabHeights(ground, 30, () => 0, 1)) assert.ok(Math.abs((slab - rowLo) / floorH - Math.round((slab - rowLo) / floorH)) < 1e-9, `balcony slab ${slab} sits at the sill height of a row`);
  }
  const ac = acParts(1);
  const lo = Math.min(...ac.map((b) => b.h0)) + 1.0;
  const hi = Math.max(...ac.map((b) => b.h1)) + 1.0;
  assert.ok(lo >= rowLo && hi <= rowHi + 0.5, `a unit based 1.0 above the row line spans ${lo}..${hi}, inside or just above the ${rowLo}..${rowHi} glass band`);
});

test('shutters: rows are the shader rows, open panels sit beside the glass, closed ones cover exactly the glass', () => {
  for (const m of shutterRows(0, 20, () => 0, 1)) assert.ok(Math.abs(m / floorH - Math.round(m / floorH)) < 1e-9);
  const open = shutterParts(false).filter((b) => b.role === 'panel');
  const closed = shutterParts(true).filter((b) => b.role === 'panel');
  for (const b of [...open, ...closed]) {
    assert.equal(b.h0, rowLo);
    assert.equal(b.h1, rowHi);
  }
  for (const b of open) assert.ok(Math.min(Math.abs(b.u0), Math.abs(b.u1)) >= halfGlass, 'open panels start where the glass ends');
  const reach = Math.max(...closed.flatMap((b) => [Math.abs(b.u0), Math.abs(b.u1)]));
  assert.ok(Math.abs(reach - halfGlass) < 1e-9, 'closed panels cover the whole glass width');
  assert.ok(Math.max(...open.flatMap((b) => [Math.abs(b.u0), Math.abs(b.u1)])) < colW - halfGlass, 'open panels stay clear of the next column glass');
});

// height above the floor line below, counted past the line into the next floor when it falls in the gap after the glass
const gapPhase = (h) => {
  const p = ((h % floorH) + floorH) % floorH;
  return p < rowLo ? p + floorH : p;
};

test('street plates and trim bands sit in the gap between glass rows, at any ground level', () => {
  for (const ground of [0, 0.7, 2.9, 35.5, 118.2]) {
    const c = plateCentre(ground, 30);
    const phase = gapPhase(c);
    const half = Math.max(...plateParts(3).map((b) => b.h1));
    assert.ok(phase - half > rowHi && phase + half < floorH + rowLo, `${ground}: plate at phase ${phase} clears glass ${rowLo}..${rowHi} of both rows even at size 3`);
    for (const b of trimBands(ground, ground + 20, 0.07, ground).filter((x) => x.role === 'floor')) {
      const p0 = gapPhase(b.h0);
      assert.ok(p0 > rowHi && p0 + (b.h1 - b.h0) < floorH + rowLo, `${ground}: string course at phase ${p0}`);
    }
  }
});
