import assert from 'node:assert/strict';
import test from 'node:test';
import { COL_W, FLOOR_H, STYLES, facadeShapes, groundFloor, styleOf } from '../web/js/facade.js';
import { canOpen, cellContent, columnOf, gapFits, rowOf, windowBox } from '../web/js/facadefit.js';
import { acParts } from '../web/js/acunits.js';
import { shutterParts } from '../web/js/shutters.js';

// facadeShapes (what the SVG export draws) is the independent truth here: every placement the fit functions accept must
// stay off the windows and doors it lists, and every cell they call a window must be one it lists.
const EPS = 1e-6;
const SETTINGS = [[1, 1], [0.6, 0.5], [0.3, 0], [1, 0.2]];
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 17 + 3);
const BASES = [0, 1.9, 6.4, 33.3];
const U0 = -45;
const U1 = 45;
const TOP = 40;

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > EPS;

function* facades() {
  for (const [variety, openings] of SETTINGS) for (const seed of SEEDS) for (const base of BASES) {
    const fac = { seed, base, variety, openings };
    yield { fac, ...facadeShapes(seed, base, U0, U1, base - 1, TOP, { variety, openings }) };
  }
}

test('cellContent names exactly the windows and doors facadeShapes draws', () => {
  for (const { fac, windows, doors } of facades()) {
    const f0 = groundFloor(fac.base);
    for (let c = columnOf(U0) + 1; c < columnOf(U1) - 1; c++) for (let row = f0 - 1; row <= f0 + 8; row++) {
      const y = row * FLOOR_H;
      const cell = cellContent(fac, c, row);
      const o = c * COL_W;
      // a shop window starts above the base, not the row line, and may straddle two rows: it is told apart by its sill
      const inCol = windows.filter((w) => w.u0 >= o - EPS && w.u1 <= o + COL_W + EPS);
      const drawn = cell.kind === 'shop' ? inCol.filter((w) => Math.abs(w.y0 - (fac.base + 0.45)) < 1e-9) : inCol.filter((w) => w.y0 >= y - EPS && w.y1 <= y + FLOOR_H + EPS);
      // facadeShapes drops windows that poke out of the wall (below `bottom + 0.3` or above the roof), so only compare whole cells
      if (y + FLOOR_H > TOP - 1 || y < fac.base - 1 + 0.3) continue;
      assert.equal(drawn.length, cell.glass.length, `seed ${fac.seed} base ${fac.base} column ${c} row ${row} (${cell.kind})`);
      for (const [a, b, lo, hi] of cell.glass) {
        assert.ok(drawn.some((w) => Math.abs(w.u0 - o - a) < 1e-9 && Math.abs(w.u1 - o - b) < 1e-9 && Math.abs(w.y0 - y - lo) < 1e-9 && Math.abs(w.y1 - y - hi) < 1e-9), `window ${a},${b},${lo},${hi}`);
      }
      const door = doors.some((d) => d.u0 >= o - EPS && d.u1 <= o + COL_W + EPS && Math.abs(d.y0 - fac.base) < 1e-9); // doors stand on the ground, not on the row line
      assert.equal(door && row === f0, cell.kind === 'opening', `door at seed ${fac.seed} column ${c} row ${row}`);
    }
  }
});

test('an air-conditioner unit that gapFits accepts never covers a window or door', () => {
  let accepted = 0;
  let refused = 0;
  for (const { fac, windows, doors } of facades()) {
    const f0 = groundFloor(fac.base);
    for (const size of [0.6, 1, 1.6]) {
      const [casing] = acParts(size);
      const width = casing.u1 - casing.u0;
      for (let k = columnOf(U0) + 2; k < columnOf(U1) - 2; k++) for (let row = f0; row <= f0 + 6 && (row + 1) * FLOOR_H <= TOP - 1; row++) {
        const fits = gapFits(fac, k, row, width);
        fits ? accepted++ : refused++;
        const y = row * FLOOR_H;
        const covered = [...windows, ...doors].some((w) => overlap(w.u0, w.u1, k * COL_W - width / 2 + 0.05, k * COL_W + width / 2 - 0.05) && overlap(w.y0, w.y1, y + 1.0, y + 1.0 + casing.h1));
        if (fits) assert.ok(!covered, `seed ${fac.seed} base ${fac.base} gap ${k} row ${row} size ${size} covers glass`);
        // refusing must have a reason: the unit would overlap glass by more than the tolerance
        else {
          const wide = [...windows, ...doors].some((w) => overlap(w.u0, w.u1, k * COL_W - width / 2 + 0.05 - 0.01, k * COL_W + width / 2 - 0.05 + 0.01) && w.y1 > y + 0.5 && w.y0 < y + FLOOR_H);
          const blankNeighbour = [k - 1, k].some((c) => cellContent(fac, c, row).kind !== 'windows');
          assert.ok(wide || blankNeighbour || row === f0, `seed ${fac.seed} gap ${k} row ${row}: refused with nothing in the way`);
        }
      }
    }
  }
  assert.ok(accepted > 1000 && refused > 1000, `both branches are exercised (${accepted} accepted, ${refused} refused)`);
});

test('classic-window buildings keep every air-conditioner gap above the ground floor, as before the facades', () => {
  const classic = SEEDS.filter((s) => styleOf(s, 1) === 0);
  assert.ok(classic.length > 5);
  for (const seed of classic) {
    const fac = { seed, base: 0, variety: 1, openings: 0 };
    for (let k = -10; k < 10; k++) for (let row = 1; row < 8; row++) {
      // a blank neighbour widens the gap, a shop window narrows it; with doors off there are neither on the ground floor
      assert.ok(gapFits(fac, k, row, 0.8), `seed ${seed} gap ${k} row ${row}`);
    }
  }
  for (const style of ['ribbon', 'pair']) {
    const seed = SEEDS.find((s) => STYLES[styleOf(s, 1)].id === style);
    assert.ok(seed !== undefined, style);
    for (let k = -10; k < 10; k++) assert.equal(gapFits({ seed, base: 0, variety: 1, openings: 0 }, k, 3, 0.8), false, `${style}: the gap is too narrow for a unit`);
  }
});

test('windowBox is the glass of ordinary cells only, the bounding box of its rectangles', () => {
  for (const { fac, windows } of facades()) {
    const f0 = groundFloor(fac.base);
    for (let c = -10; c < 10; c++) for (let row = f0; row <= f0 + 8; row++) {
      const box = windowBox(fac, c, row);
      const cell = cellContent(fac, c, row);
      if (cell.kind !== 'windows') {
        assert.equal(box, null);
        continue;
      }
      const o = c * COL_W;
      const y = row * FLOOR_H;
      const drawn = windows.filter((w) => w.u0 >= o && w.u1 <= o + COL_W && w.y0 >= y && w.y1 <= y + FLOOR_H);
      if (y + FLOOR_H > TOP - 1 || y < fac.base - 1 + 0.3) continue;
      assert.ok(drawn.length > 0);
      assert.ok(Math.abs(box.half - (Math.max(...drawn.map((w) => w.u1)) - Math.min(...drawn.map((w) => w.u0))) / 2) < 1e-9);
      assert.ok(Math.abs(box.y0 - (Math.min(...drawn.map((w) => w.y0)) - y)) < 1e-9);
      assert.ok(Math.abs(box.y1 - (Math.max(...drawn.map((w) => w.y1)) - y)) < 1e-9);
    }
  }
});

test('shutters follow the glass of every window style: closed ones cover it, open ones stand beside it inside the column', () => {
  const seen = new Set();
  for (const [i, style] of STYLES.entries()) {
    const seed = SEEDS.find((s) => styleOf(s, 1) === i);
    const fac = { seed, base: 0, variety: 1, openings: 0 };
    const col = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].find((c) => windowBox(fac, c, 3)); // not a blank column
    const box = windowBox(fac, col, 3);
    assert.ok(box, style.id);
    for (const closed of [true, false]) {
      const useClosed = closed || !canOpen(box.half);
      seen.add(`${style.id}:${useClosed ? 'closed' : 'open'}`);
      const parts = shutterParts(useClosed, box);
      const panels = parts.filter((b) => b.role === 'panel');
      assert.equal(panels.length, 2);
      for (const p of panels) {
        assert.equal(p.h0, box.y0, `${style.id}: panel starts at the sill`);
        assert.equal(p.h1, box.y1, `${style.id}: panel ends at the head`);
        if (useClosed) assert.ok(Math.max(Math.abs(p.u0), Math.abs(p.u1)) <= box.half + EPS && Math.min(Math.abs(p.u0), Math.abs(p.u1)) <= 0.02 + EPS, `${style.id}: closed panel stays over the glass`);
        else assert.ok(Math.min(Math.abs(p.u0), Math.abs(p.u1)) >= box.half && Math.max(Math.abs(p.u0), Math.abs(p.u1)) <= COL_W / 2 - 0.1 + EPS, `${style.id}: open panel is beside the glass and inside the column`);
      }
      for (const sl of parts.filter((b) => b.role === 'slat')) assert.ok(sl.h0 >= box.y0 && sl.h1 <= box.y1, `${style.id}: slat inside the panel`);
      assert.ok(parts.filter((b) => b.role === 'slat').length >= 3, `${style.id}: slats on both panels`);
    }
  }
  // the branch that closes shutters which have no room: ribbon and pair windows fill the column, the others leave a margin
  assert.ok(seen.has('ribbon:closed') && !seen.has('ribbon:open') && seen.has('pair:closed') && !seen.has('pair:open'));
  assert.ok(seen.has('classic:open') && seen.has('tall:open') && seen.has('small:open'));
});

test('row and column indices round-trip the shader grid', () => {
  for (const row of [-3, 0, 4, 11]) assert.equal(rowOf(row * FLOOR_H + 0.8), row, 'balcony slab');
  for (const row of [-3, 0, 4, 11]) assert.equal(rowOf(row * FLOOR_H), row, 'shutter row');
  for (const row of [-3, 0, 4, 11]) assert.equal(rowOf(row * FLOOR_H + 1.0 - 1.0), row, 'AC base minus 1.0');
  assert.equal(columnOf(-0.01), -1);
  assert.equal(columnOf(3), 1);
});
