// What a wall column holds on a given floor, for the things that hang on facades (balconies, air-conditioner units,
// shutters). Those modules place their pieces on the shader's window grid; with procedural facades (facade.js) the glass
// of a cell depends on the building, so they ask here instead of assuming the classic window. Pure decisions, no rendering.
// `fac` is { seed, base, variety, openings } as the shader sees the building: its facade seed, ground level (1e4 for a
// raised part with no ground floor) and the two facade sliders as 0..1.

import { COL_W, DOOR, FLOOR_H, PASSAGE, SHOP, STYLES, groundFloor, groundKind, isBlank, styleOf } from './facade.js';

/** Index of the window column a world coordinate along the wall falls in. */
export const columnOf = (u) => Math.floor(u / COL_W);

/** Index of the floor row whose base is the world height `y` (rows start at multiples of 3.2). */
export const rowOf = (y) => Math.round(y / FLOOR_H);

/**
 * Content of column `c` on floor row `row`:
 * { kind: 'windows' | 'shop' | 'opening' | 'blank', glass: [[u0, u1, y0, y1], ...], solid: [[u0, u1], ...] }
 * `glass` are the window rectangles inside the column (u across it, y up from the row base, metres), `solid` the
 * door or passage that takes the place of a window. Mirrors fcCell in render.js.
 */
export function cellContent(fac, c, row) {
  const f0 = groundFloor(fac.base);
  if (row === f0) {
    const g = groundKind(fac.seed, c, fac.openings);
    if (g === 1) return { kind: 'opening', glass: [], solid: [[DOOR.u0, DOOR.u1]] };
    if (g === 2) return { kind: 'opening', glass: [], solid: [[PASSAGE.u0, PASSAGE.u1]] };
    if (g === 3) return { kind: 'shop', glass: [[SHOP.u0, SHOP.u1, fac.base + SHOP.y0 - row * FLOOR_H, fac.base + SHOP.y1 - row * FLOOR_H]], solid: [] };
  } else if (row > f0 && isBlank(fac.seed, c, fac.variety)) {
    return { kind: 'blank', glass: [], solid: [] };
  }
  return { kind: 'windows', glass: STYLES[styleOf(fac.seed, fac.variety)].rects, solid: [] };
}

/** The window of an ordinary cell as one box: { half, y0, y1 } (half-width about the column centre), or null when it has none. */
export function windowBox(fac, c, row) {
  const cell = cellContent(fac, c, row);
  if (cell.kind !== 'windows') return null;
  const u0 = Math.min(...cell.glass.map((r) => r[0]));
  const u1 = Math.max(...cell.glass.map((r) => r[1]));
  return { half: (u1 - u0) / 2, y0: Math.min(...cell.glass.map((r) => r[2])), y1: Math.max(...cell.glass.map((r) => r[3])) };
}

/**
 * Whether a unit `width` metres wide, centred on the gap between columns k - 1 and k on floor row `row`, clears the glass
 * and doors either side of it. A couple of centimetres overlap is tolerated: the units stand off the wall.
 */
export function gapFits(fac, k, row, width) {
  const edge = (c, side) => {
    const cell = cellContent(fac, c, row);
    const rects = [...cell.glass, ...cell.solid];
    if (!rects.length) return COL_W;
    return side < 0 ? COL_W - Math.max(...rects.map((r) => r[1])) : Math.min(...rects.map((r) => r[0]));
  };
  const need = width / 2 - 0.05;
  return edge(k - 1, -1) >= need && edge(k, 1) >= need;
}

/** Whether the shutters of a window with half-width `half` can stand open beside it (a quarter metre of column to spare), else they close. */
export function canOpen(half) {
  return COL_W / 2 - 0.1 - (half + 0.02) >= 0.25;
}
